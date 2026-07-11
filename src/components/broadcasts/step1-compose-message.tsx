'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, CustomField } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, ArrowRight, Eye, Loader2, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { renderBroadcastText } from '@/lib/broadcasts/render';

// WhatsApp caps a single text message at 4096 chars. Enforced here so
// the user never composes a body the provider will reject at send time.
const MAX_CHARS = 4096;

export type ComposeMediaType = '' | 'image' | 'video' | 'document' | 'audio';

const MEDIA_TYPES: Exclude<ComposeMediaType, ''>[] = [
  'image',
  'video',
  'document',
  'audio',
];

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

interface Step1ComposeProps {
  content: string;
  onContentChange: (content: string) => void;
  mediaUrl: string;
  onMediaUrlChange: (url: string) => void;
  mediaType: ComposeMediaType;
  onMediaTypeChange: (type: ComposeMediaType) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ComposeMessage({
  content,
  onContentChange,
  mediaUrl,
  onMediaUrlChange,
  mediaType,
  onMediaTypeChange,
  onNext,
  onBack,
}: Step1ComposeProps) {
  const t = useTranslations('Broadcasts.compose');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [sampleContact, setSampleContact] = useState<Contact | null>(null);
  // custom values of the sample contact, keyed by field_name.toLowerCase()
  // to match how renderBroadcastText resolves placeholders at send time.
  const [sampleCustomValues, setSampleCustomValues] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      const fields = (fieldsRes.data ?? []) as CustomField[];
      setCustomFields(fields);
      setLoadingFields(false);

      const contact = (contactRes.data ?? null) as Contact | null;
      setSampleContact(contact);

      if (contact) {
        const { data: values } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (cancelled) return;
        const byId = new Map(fields.map((f) => [f.id, f.field_name]));
        const byName: Record<string, string> = {};
        for (const row of values ?? []) {
          const fieldName = byId.get(row.custom_field_id);
          if (fieldName) byName[fieldName.toLowerCase()] = row.value ?? '';
        }
        setSampleCustomValues(byName);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Insert `token` at the caret (or replace the current selection). */
  function insertPlaceholder(token: string) {
    const el = textareaRef.current;
    if (!el) {
      onContentChange(content + token);
      return;
    }
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? content.length;
    const next = content.slice(0, start) + token + content.slice(end);
    onContentChange(next.slice(0, MAX_CHARS));
    // Restore the caret just after the inserted token on the next tick.
    requestAnimationFrame(() => {
      el.focus();
      const caret = Math.min(start + token.length, MAX_CHARS);
      el.setSelectionRange(caret, caret);
    });
  }

  const mediaUrlValid = mediaType === '' || isValidHttpUrl(mediaUrl.trim());
  const overLimit = content.length > MAX_CHARS;

  const canContinue =
    content.trim().length > 0 && !overLimit && mediaUrlValid;

  const previewText = useMemo(
    () =>
      renderBroadcastText(content, {
        name: sampleContact?.name ?? t('previewSampleName'),
        customValues: sampleCustomValues,
      }),
    [content, sampleContact, sampleCustomValues, t],
  );

  const previewLabel = sampleContact
    ? sampleContact.name || sampleContact.phone
    : t('previewSample');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {/* Message editor */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <label className="mb-1.5 block text-sm font-medium text-foreground">
          {t('messageLabel')}
        </label>
        <Textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => onContentChange(e.target.value.slice(0, MAX_CHARS))}
          placeholder={t('placeholder')}
          rows={6}
          className="min-h-32 resize-y border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
        <div className="mt-1.5 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{t('placeholderHint')}</p>
          <span
            className={`text-xs tabular-nums ${
              overLimit ? 'text-red-400' : 'text-muted-foreground'
            }`}
          >
            {content.length} / {MAX_CHARS}
          </span>
        </div>

        {/* Placeholder insertion buttons */}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => insertPlaceholder('{{nome}}')}
            className="inline-flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
          >
            <Plus className="h-3 w-3" />
            {'{{nome}}'}
          </button>
          {loadingFields ? (
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
          ) : (
            customFields.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => insertPlaceholder(`{{${f.field_name}}}`)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
                {`{{${f.field_name}}}`}
              </button>
            ))
          )}
        </div>
      </div>

      {/* Optional media */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="mb-3 text-sm font-medium text-foreground">
          {t('mediaOptional')}
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {t('mediaType')}
            </label>
            <Select
              value={mediaType === '' ? 'none' : mediaType}
              onValueChange={(val) =>
                onMediaTypeChange(val === 'none' ? '' : (val as ComposeMediaType))
              }
            >
              <SelectTrigger className="w-full border-border bg-muted text-foreground">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-border bg-popover">
                <SelectItem value="none">{t('mediaTypeNone')}</SelectItem>
                {MEDIA_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(`mediaKind.${type}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {mediaType !== '' && (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                {t('mediaUrl')}
              </label>
              <Input
                type="url"
                value={mediaUrl}
                onChange={(e) => onMediaUrlChange(e.target.value)}
                placeholder={t('mediaUrlPlaceholder')}
                className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
              />
              {mediaUrl.trim() && !mediaUrlValid && (
                <p className="mt-1.5 text-xs text-amber-300">
                  {t('mediaUrlInvalid')}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Live preview — bubble styled after the inbox, no inbox import. */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="h-4 w-4 text-primary" />
          <p className="text-sm font-medium text-foreground">{t('preview')}</p>
          <span className="text-xs text-muted-foreground">({previewLabel})</span>
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="ml-auto max-w-[85%] space-y-2">
            {mediaType === 'image' && mediaUrl.trim() && mediaUrlValid && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={mediaUrl.trim()}
                alt="Media preview"
                className="max-h-40 rounded-lg border border-border object-contain"
              />
            )}
            {mediaType !== '' && mediaType !== 'image' && mediaUrl.trim() && (
              <div className="rounded-md bg-primary/20 px-3 py-2 text-xs text-primary">
                {t(`mediaKind.${mediaType}`)}
              </div>
            )}
            {previewText.trim() ? (
              <div className="rounded-lg bg-primary/30 px-3 py-2 shadow-sm">
                <p className="whitespace-pre-wrap text-sm text-primary">
                  {previewText}
                </p>
              </div>
            ) : (
              <div className="rounded-lg bg-primary/10 px-3 py-2 shadow-sm">
                <p className="text-sm italic text-muted-foreground">
                  {t('previewEmpty')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!canContinue}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
