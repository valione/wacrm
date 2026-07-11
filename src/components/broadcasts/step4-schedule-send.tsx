'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  Clock,
  Loader2,
  Save,
  Send,
  Users,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  /** Present in template (Meta) mode; absent for free-text broadcasts. */
  template?: MessageTemplate;
  /** Present in free-text mode; used for the summary preview. */
  contentText?: string;
  /** True for non-official providers (WAHA/Uazapi) — free-text sends. */
  isFreeText: boolean;
  audience: AudienceConfig;
  /** `scheduledAt` is an ISO string when scheduling, or null for "send now". */
  onSend: (scheduledAt: string | null) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

/** Free-text broadcasts drain at ~10 msgs/min on the safe-pace worker. */
const SAFE_RATE_PER_MIN = 10;
/** Scheduling floor — the backend rejects anything not in the future. */
const MIN_LEAD_MS = 5 * 60 * 1000;

/** Format a Date as the local value a `datetime-local` input expects. */
function toDatetimeLocal(d: Date): string {
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  contentText,
  isFreeText,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const ts = useTranslations('Broadcasts.schedule');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  const [mode, setMode] = useState<'now' | 'schedule'>('now');
  const [scheduledLocal, setScheduledLocal] = useState('');

  // Recomputed on each render so a wizard left open for a while still
  // rejects a time that has since slipped inside the lead window.
  const minLocal = toDatetimeLocal(new Date(Date.now() + MIN_LEAD_MS));

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  const scheduleError = useMemo<'required' | 'past' | null>(() => {
    if (mode !== 'schedule') return null;
    if (!scheduledLocal) return 'required';
    const ms = new Date(scheduledLocal).getTime();
    if (Number.isNaN(ms) || ms <= Date.now()) return 'past';
    return null;
  }, [mode, scheduledLocal]);

  const estimatedMinutes = Math.max(1, Math.ceil(estimatedReach / SAFE_RATE_PER_MIN));

  const canSubmit = name.trim().length > 0 && scheduleError === null && !isProcessing;

  function handleConfirm() {
    setShowConfirm(false);
    const scheduledAt =
      mode === 'schedule' && scheduledLocal
        ? new Date(scheduledLocal).toISOString()
        : null;
    onSend(scheduledAt);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          {isFreeText ? (
            <div className="col-span-2">
              <p className="text-xs text-muted-foreground">{ts('message')}</p>
              <p className="line-clamp-2 whitespace-pre-wrap text-foreground">
                {contentText?.trim() || '—'}
              </p>
            </div>
          ) : (
            <div>
              <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
              <p className="text-foreground">{template?.name ?? '—'}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{ts('estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          {!isFreeText && (
            <div>
              <p className="text-xs text-muted-foreground">{ts('language')}</p>
              <p className="text-foreground">{template?.language ?? 'en_US'}</p>
            </div>
          )}
        </div>
      </div>

      {/* Scheduling */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{ts('whenLabel')}</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode('now')}
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
              mode === 'now'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            <Send className="h-4 w-4" />
            {ts('sendNow')}
          </button>
          <button
            type="button"
            onClick={() => setMode('schedule')}
            className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all ${
              mode === 'schedule'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-muted text-muted-foreground hover:text-foreground'
            }`}
          >
            <CalendarClock className="h-4 w-4" />
            {ts('scheduleLater')}
          </button>
        </div>

        {mode === 'schedule' && (
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              {ts('scheduledAt')}
            </label>
            <Input
              type="datetime-local"
              value={scheduledLocal}
              min={minLocal}
              onChange={(e) => setScheduledLocal(e.target.value)}
              className="border-border bg-muted text-foreground [color-scheme:dark]"
            />
            {scheduleError ? (
              <p className="mt-1.5 text-xs text-amber-300">
                {scheduleError === 'required' ? ts('scheduleRequired') : ts('scheduleInPast')}
              </p>
            ) : (
              <p className="mt-1.5 text-xs text-muted-foreground">{ts('minHint')}</p>
            )}
          </div>
        )}

        {isFreeText && estimatedReach > 0 && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5 text-primary" />
            <span>
              {ts('estimatedDuration', { minutes: estimatedMinutes })}{' '}
              <span className="text-muted-foreground/80">{ts('safePace')}</span>
            </span>
          </div>
        )}
      </div>

      {/* Ban warning for non-official providers */}
      {isFreeText && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{ts('banWarning')}</span>
        </div>
      )}

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">{t('scheduleSend.sending')}</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger
              render={
                <Button
                  disabled={!canSubmit}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                />
              }
            >
              {mode === 'schedule' ? (
                <CalendarClock className="h-4 w-4" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              {mode === 'schedule' ? ts('scheduleButton') : t('scheduleSend.sendNow')}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">
                  {mode === 'schedule' ? ts('confirmScheduleTitle') : ts('confirmSendTitle')}
                </DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {mode === 'schedule'
                    ? ts('confirmScheduleDesc', {
                        count: estimatedReach.toLocaleString(),
                      })
                    : ts('confirmSendDesc', {
                        count: estimatedReach.toLocaleString(),
                      })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowConfirm(false)}
                  className="border-border text-muted-foreground"
                >
                  {t('cancel')}
                </Button>
                <Button
                  onClick={handleConfirm}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {mode === 'schedule' ? (
                    <CalendarClock className="h-4 w-4" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  {mode === 'schedule' ? ts('scheduleButton') : t('scheduleSend.sendNow')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
