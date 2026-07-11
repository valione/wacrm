'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import {
  Step1ComposeMessage,
  type ComposeMediaType,
} from '@/components/broadcasts/step1-compose-message';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { useProviderCapabilities } from '@/lib/whatsapp/use-provider-capabilities';
import type { AudienceInput } from '@/lib/broadcasts/audience';
import { Check, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

type WizardAudience = {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: {
    fieldId: string;
    operator: 'is' | 'is_not' | 'contains';
    value: string;
  };
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
};

/**
 * Map the wizard's audience shape to the server contract of
 * POST /api/whatsapp/broadcasts. CSV rows are upserted to contacts in the
 * browser (as the immediate-send hook already does) and passed as
 * `contact_ids`. The server-side custom-field filter is equality-only, so
 * the operator is not carried over.
 */
async function toServerAudience(
  audience: WizardAudience,
  supabase: ReturnType<typeof createClient>,
  userId: string,
  accountId: string,
): Promise<AudienceInput> {
  const excludeTagIds = audience.excludeTagIds;
  switch (audience.type) {
    case 'all':
      return { type: 'all', excludeTagIds };
    case 'tags':
      return { type: 'tags', tagIds: audience.tagIds, excludeTagIds };
    case 'custom_field':
      return {
        type: 'custom_field',
        field: audience.customField?.fieldId,
        value: audience.customField?.value,
        excludeTagIds,
      };
    case 'csv': {
      const contactIds = await upsertCsvContacts(
        supabase,
        audience.csvContacts ?? [],
        userId,
        accountId,
      );
      return { type: 'contact_ids', contactIds, excludeTagIds };
    }
  }
}

/**
 * Resolve CSV phone/name rows to `contacts.id` UUIDs, inserting any that
 * don't exist yet. Mirrors the immediate-send hook's CSV handling so the
 * scheduled/non-official path produces the same real contact rows.
 */
async function upsertCsvContacts(
  supabase: ReturnType<typeof createClient>,
  rows: { phone: string; name?: string }[],
  userId: string,
  accountId: string,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
  for (const row of rows) if (row.phone) uniqueByPhone.set(row.phone, row);
  const phones = [...uniqueByPhone.keys()];

  const { data: existing } = await supabase
    .from('contacts')
    .select('id, phone')
    .eq('user_id', userId)
    .in('phone', phones);

  const idByPhone = new Map<string, string>();
  for (const c of existing ?? []) {
    if (c.phone) idByPhone.set(c.phone as string, c.id as string);
  }

  const missing = phones
    .filter((p) => !idByPhone.has(p))
    .map((phone) => ({
      user_id: userId,
      account_id: accountId,
      phone,
      name: uniqueByPhone.get(phone)?.name ?? null,
    }));

  const INSERT_CHUNK = 200;
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const chunk = missing.slice(i, i + INSERT_CHUNK);
    const { data: inserted, error } = await supabase
      .from('contacts')
      .insert(chunk)
      .select('id, phone');
    if (error) throw new Error(`Failed to create CSV contacts: ${error.message}`);
    for (const c of inserted ?? []) {
      if (c.phone) idByPhone.set(c.phone as string, c.id as string);
    }
  }

  return phones
    .map((p) => idByPhone.get(p))
    .filter((id): id is string => Boolean(id));
}

export default function NewBroadcastPage() {
  const router = useRouter();
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();
  const capabilities = useProviderCapabilities();

  // null while capabilities load; once known, non-official providers
  // (supportsTemplates === false) compose free text instead of picking a
  // Meta template.
  const isFreeText = capabilities ? !capabilities.supportsTemplates : null;

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<WizardAudience>({ type: 'all' });
  const [variables, setVariables] = useState<
    Record<string, { type: 'static' | 'field' | 'custom_field'; value: string }>
  >({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [name, setName] = useState('');

  // Free-text composition state.
  const [content, setContent] = useState('');
  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaType, setMediaType] = useState<ComposeMediaType>('');

  const [submitting, setSubmitting] = useState(false);

  const steps: { label: string; key: string }[] = isFreeText
    ? [
        { label: 'compose', key: 'template' },
        { label: 'audience', key: 'audience' },
        { label: 'review', key: 'personalize' },
        { label: 'send', key: 'send' },
      ]
    : [
        { label: 'template', key: 'template' },
        { label: 'audience', key: 'audience' },
        { label: 'personalize', key: 'personalize' },
        { label: 'send', key: 'send' },
      ];

  /**
   * Final submit. Two paths, decided by the plan's global constraint:
   *  - Meta immediate template (official + "send now") → the existing
   *    `useBroadcastSending` hook, untouched.
   *  - Free text (non-official) OR any scheduled send → the new
   *    POST /api/whatsapp/broadcasts route + navigate to the detail page.
   */
  async function handleSend(scheduledAt: string | null) {
    const useNewRoute = isFreeText === true || scheduledAt !== null;

    if (!useNewRoute) {
      // Meta immediate template flow — unchanged.
      if (!template) return;
      try {
        const broadcastId = await createAndSendBroadcast({
          name,
          template,
          audience: {
            type: audience.type,
            tagIds: audience.tagIds,
            customField: audience.customField,
            csvContacts: audience.csvContacts,
            excludeTagIds: audience.excludeTagIds,
          },
          variables,
          headerMediaUrl,
        });
        router.push(`/broadcasts/${broadcastId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Broadcast failed';
        console.error('Broadcast failed:', err);
        toast.error(message);
      }
      return;
    }

    // New route: free-text and/or scheduled broadcasts.
    setSubmitting(true);
    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error(t('toastNotSignedIn'));
        return;
      }
      if (!accountId) {
        toast.error(t('toastNotLinked'));
        return;
      }

      const serverAudience = await toServerAudience(
        audience,
        supabase,
        user.id,
        accountId,
      );

      const body: Record<string, unknown> = {
        name: name.trim(),
        audience: serverAudience,
      };
      if (scheduledAt) body.scheduled_at = scheduledAt;

      if (isFreeText) {
        body.content_text = content;
        if (mediaType && mediaUrl.trim()) {
          body.content_media_url = mediaUrl.trim();
          body.content_media_type = mediaType;
        }
      } else if (template) {
        // Scheduled Meta template.
        body.template_name = template.name;
        body.template_language = template.language ?? 'en_US';
        body.template_variables = variables;
      }

      const res = await fetch('/api/whatsapp/broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok) {
        // Backend 4xx bodies carry a human-readable `message`.
        const message =
          data?.message || data?.error || t('toastCreateFailed');
        toast.error(message);
        return;
      }

      router.push(`/broadcasts/${data.broadcast_id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('toastCreateFailed');
      console.error('Broadcast create failed:', err);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSaveDraft() {
    if (!template || !name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await supabase.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      name: name.trim(),
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
      },
      status: 'draft',
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  const busy = isProcessing || submitting;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      {/* Step Indicator */}
      <div className="flex items-center justify-between">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <div key={step.key} className="flex flex-1 items-center">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition-all ${
                    isCompleted
                      ? 'bg-primary text-primary-foreground'
                      : isActive
                        ? 'border-2 border-primary bg-primary/10 text-primary'
                        : 'border border-border bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="h-4 w-4" /> : index + 1}
                </div>
                <span
                  className={`hidden text-sm font-medium sm:block ${
                    isActive ? 'text-foreground' : isCompleted ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {t(`steps.${step.label}`)}
                </span>
              </div>
              {index < steps.length - 1 && (
                <div
                  className={`mx-3 h-px flex-1 ${
                    index < currentStep ? 'bg-primary' : 'bg-muted'
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Step Content */}
      <div className="relative min-h-[400px]">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: busy ? 0.6 : 1,
            pointerEvents: busy ? 'none' : 'auto',
          }}
        >
          {isFreeText === null ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : (
            <>
              {currentStep === 0 &&
                (isFreeText ? (
                  <Step1ComposeMessage
                    content={content}
                    onContentChange={setContent}
                    mediaUrl={mediaUrl}
                    onMediaUrlChange={setMediaUrl}
                    mediaType={mediaType}
                    onMediaTypeChange={setMediaType}
                    onNext={() => setCurrentStep(1)}
                    onBack={() => router.push('/broadcasts')}
                  />
                ) : (
                  <Step1ChooseTemplate
                    selectedTemplate={template}
                    onSelect={setTemplate}
                    onNext={() => setCurrentStep(1)}
                    onBack={() => router.push('/broadcasts')}
                  />
                ))}
              {currentStep === 1 && (
                <Step2SelectAudience
                  audience={audience}
                  onUpdate={setAudience}
                  onNext={() => setCurrentStep(2)}
                  onBack={() => setCurrentStep(0)}
                />
              )}
              {currentStep === 2 &&
                (isFreeText ? (
                  <Step3Personalize
                    freeTextContent={content}
                    onNext={() => setCurrentStep(3)}
                    onBack={() => setCurrentStep(1)}
                  />
                ) : (
                  template && (
                    <Step3Personalize
                      template={template}
                      variables={variables}
                      onUpdate={setVariables}
                      headerMediaUrl={headerMediaUrl}
                      onHeaderMediaUrlChange={setHeaderMediaUrl}
                      onNext={() => setCurrentStep(3)}
                      onBack={() => setCurrentStep(1)}
                    />
                  )
                ))}
              {currentStep === 3 && (
                <Step4ScheduleSend
                  name={name}
                  onNameChange={setName}
                  template={template ?? undefined}
                  contentText={content}
                  isFreeText={isFreeText}
                  audience={audience}
                  onSend={handleSend}
                  onSaveDraft={isFreeText ? undefined : handleSaveDraft}
                  onBack={() => setCurrentStep(2)}
                  isProcessing={busy}
                  progress={progress}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
