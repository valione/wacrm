'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { createClient } from '@/lib/supabase/client';
import { Broadcast, BroadcastRecipient, RecipientStatus } from '@/types';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft,
  Loader2,
  Users,
  Send,
  CheckCheck,
  Eye,
  AlertCircle,
  AlertTriangle,
  MessageCircle,
  Filter,
  Download,
  Trash2,
  PauseCircle,
  PlayCircle,
  Ban,
  ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBroadcastStatus,
  getRecipientStatus,
} from '@/lib/broadcast-status';
import { useTranslations } from 'next-intl';

/** Broadcast statuses driven by the cron processor (Task 4) — the
 * detail page polls while in any of these and shows pause/resume/
 * cancel controls for broadcasts on the cron path. */
const CRON_ACTIVE_STATUSES: readonly string[] = ['scheduled', 'sending', 'paused'];

/** How often to re-poll while the broadcast is cron-active. */
const POLL_INTERVAL_MS = 5000;

/** No counter movement for this long while `sending` → cron looks stuck. */
const STALL_THRESHOLD_MS = 5 * 60 * 1000;

type BroadcastAction = 'pause' | 'resume' | 'cancel';

/** Signature of the counters we watch for stall detection. */
function countsSignature(b: Broadcast): string {
  return [b.sent_count, b.delivered_count, b.read_count, b.replied_count, b.failed_count].join(
    ':',
  );
}

/** First ~80 chars of free-text content, for the header subtitle when
 * there's no template_name (content_text broadcasts, migration 039). */
function summarizeContentText(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

interface StatCardProps {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ label, value, total, icon, color }: StatCardProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}>
          {icon}
        </div>
        <span className="text-xs text-muted-foreground">{pct}%</span>
      </div>
      <p className="mt-3 text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

/**
 * Pure-CSS funnel chart: decreasing-width rounded bars.
 * Width is relative to the largest step (typically Sent) so we
 * always render a full bar at the top and proportional tails.
 */
function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-foreground">Funnel</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 rounded-full bg-muted">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-foreground">
                  {step.value.toLocaleString()}
                  <span className="ml-2 text-muted-foreground/80">
                    ({pctOfSent}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
];

/**
 * CSV export helper — RFC 4180 quoting. Quote every field so
 * commas/newlines/quotes round-trip cleanly.
 */
function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('Broadcasts.detail');
  const tStatus = useTranslations('Broadcasts.status');
  const broadcastId = params.id as string;

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>(
    'all',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingAction, setPendingAction] = useState<BroadcastAction | null>(null);
  const [stalled, setStalled] = useState(false);

  // Last-seen counters signature + timestamp, for the "cron looks stuck"
  // banner — compared client-side across polls, not persisted.
  const progressRef = useRef<{ signature: string; since: number } | null>(null);

  const fetchData = useCallback(async () => {
    const supabase = createClient();

    const { data: bc, error: bcError } = await supabase
      .from('broadcasts')
      .select('*')
      .eq('id', broadcastId)
      .single();

    if (bcError) throw bcError;

    const { data: recs, error: recsError } = await supabase
      .from('broadcast_recipients')
      .select('*, contact:contacts(*)')
      .eq('broadcast_id', broadcastId)
      .order('created_at', { ascending: false });

    if (recsError) throw recsError;

    return { broadcast: bc as Broadcast, recipients: (recs ?? []) as BroadcastRecipient[] };
  }, [broadcastId]);

  // Recomputes the stall banner from a freshly fetched broadcast row.
  // Resets the baseline whenever status leaves `sending` or the
  // counters actually move; flips `stalled` once the same signature
  // has held for STALL_THRESHOLD_MS.
  const trackProgress = useCallback((bc: Broadcast) => {
    if (bc.status !== 'sending') {
      progressRef.current = null;
      setStalled(false);
      return;
    }
    const signature = countsSignature(bc);
    const now = Date.now();
    if (!progressRef.current || progressRef.current.signature !== signature) {
      progressRef.current = { signature, since: now };
      setStalled(false);
      return;
    }
    if (now - progressRef.current.since >= STALL_THRESHOLD_MS) {
      setStalled(true);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { broadcast: bc, recipients: recs } = await fetchData();
        if (cancelled) return;
        setBroadcast(bc);
        setRecipients(recs);
        trackProgress(bc);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('notFound'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchData, trackProgress, t]);

  // Poll while the broadcast is on the cron path — draft/sent/failed
  // are terminal (or not cron-driven) and don't need it. Re-runs (and
  // clears the previous interval) whenever the status changes; leaving
  // the polled set clears the interval and simply doesn't schedule a
  // new one.
  const broadcastStatus = broadcast?.status;
  useEffect(() => {
    if (!broadcastStatus || !CRON_ACTIVE_STATUSES.includes(broadcastStatus)) return;

    const interval = setInterval(async () => {
      try {
        const { broadcast: bc, recipients: recs } = await fetchData();
        setBroadcast(bc);
        setRecipients(recs);
        trackProgress(bc);
      } catch (err) {
        console.error('[broadcast detail] polling failed:', err);
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [broadcastStatus, fetchData, trackProgress]);

  async function handleAction(action: BroadcastAction) {
    if (action === 'cancel' && !window.confirm(t('controls.confirmCancel'))) {
      return;
    }
    setPendingAction(action);
    try {
      const res = await fetch(`/api/whatsapp/broadcasts/${broadcastId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.message ?? body?.error ?? t('controls.actionError'));
        return;
      }
      toast.success(t(`controls.success.${action}`));
      const { broadcast: bc, recipients: recs } = await fetchData();
      setBroadcast(bc);
      setRecipients(recs);
      trackProgress(bc);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('controls.actionError'));
    } finally {
      setPendingAction(null);
    }
  }

  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter],
  );

  function handleExport() {
    if (!broadcast) return;
    const header = [
      t('table.contact'),
      t('table.phone'),
      t('table.status'),
      t('table.sent'),
      t('table.delivered'),
      t('table.read'),
      t('table.error'),
    ];
    const rows = recipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      r.status,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }

  async function handleDelete() {
    setDeleting(true);
    const supabase = createClient();
    // broadcast_recipients cascades on broadcasts.id (migration 001), so a
    // single delete is sufficient — the aggregate trigger in migration 003
    // is defined on broadcast_recipients but fires only on its own row
    // changes, not on a cascaded drop of the parent row.
    const { error: delErr } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', broadcastId);
    setDeleting(false);
    if (delErr) {
      toast.error(t('toastFailedDelete', { error: delErr.message }));
      return;
    }
    toast.success(t('toastDeleted'));
    router.push('/broadcasts');
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !broadcast) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error ?? t('notFound')}</p>
        <Button variant="outline" onClick={() => router.push('/broadcasts')}>
          {t('backToBroadcasts')}
        </Button>
      </div>
    );
  }

  const status = getBroadcastStatus(broadcast.status);

  // Cron-path broadcasts (Task 4's processor) are the ones created via
  // the free-text/scheduled wizard — template-only instant sends never
  // set either field, so this doubles as "has pause/resume/cancel".
  const isCronPath = broadcast.content_text != null || broadcast.scheduled_at != null;
  const canPause = isCronPath && broadcast.status === 'sending';
  const canResume = isCronPath && broadcast.status === 'paused';
  const canCancel = isCronPath && CRON_ACTIVE_STATUSES.includes(broadcast.status);

  const funnelSteps: FunnelStep[] = [
    { label: t('stats.sent'), value: broadcast.sent_count, color: 'bg-primary' },
    { label: t('stats.delivered'), value: broadcast.delivered_count, color: 'bg-teal-500' },
    { label: t('stats.read'), value: broadcast.read_count, color: 'bg-blue-500' },
    { label: t('stats.replied'), value: broadcast.replied_count, color: 'bg-indigo-500' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push('/broadcasts')}
            className="border-border"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">{broadcast.name}</h1>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
              >
                {tStatus(status.label)}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              {/* template_name and content_text are mutually exclusive
                  (DB CHECK, migration 039) — prefer the template label,
                  fall back to a truncated preview of the free text, and
                  render nothing if somehow neither is set. */}
              {broadcast.template_name ? (
                <span>{t('template', { name: broadcast.template_name })}</span>
              ) : broadcast.content_text ? (
                <span>
                  {t('contentSummary', { summary: summarizeContentText(broadcast.content_text) })}
                </span>
              ) : null}
              <span>-</span>
              <span>
                {t('createdAt', { date: new Date(broadcast.created_at).toLocaleDateString() })}
              </span>
              {broadcast.status === 'scheduled' && broadcast.scheduled_at && (
                <>
                  <span>-</span>
                  <span>
                    {t('scheduledAt', { date: format(new Date(broadcast.scheduled_at), 'PP p') })}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Pause/resume/cancel — cron-path broadcasts only (Task 3's
              PATCH /api/whatsapp/broadcasts/[id]); manual instant sends
              via the Meta template flow have neither field set. */}
          {canPause && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAction('pause')}
              disabled={pendingAction !== null}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {pendingAction === 'pause' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PauseCircle className="h-3.5 w-3.5" />
              )}
              {t('controls.pause')}
            </Button>
          )}
          {canResume && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAction('resume')}
              disabled={pendingAction !== null}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {pendingAction === 'resume' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PlayCircle className="h-3.5 w-3.5" />
              )}
              {t('controls.resume')}
            </Button>
          )}
          {canCancel && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleAction('cancel')}
              disabled={pendingAction !== null}
              className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10"
            >
              {pendingAction === 'cancel' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Ban className="h-3.5 w-3.5" />
              )}
              {t('controls.cancel')}
            </Button>
          )}

          {/* Delete — inline-confirm pattern matches the pipeline-settings
              "Delete Pipeline" flow. Mid-send broadcasts can't be deleted
              because orphaning in-flight Meta messages would leave the
              funnel inconsistent. */}
          {confirmDelete ? (
            <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
              <span className="text-red-300">{t('deletePrompt')}</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="h-7 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleDelete}
                disabled={deleting}
                className="h-7 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? t('deleting') : t('confirm')}
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={broadcast.status === 'sending'}
              onClick={() => setConfirmDelete(true)}
              title={
                broadcast.status === 'sending'
                  ? t('cannotDeleteSending')
                  : t('deleteHover')
              }
              className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('delete')}
            </Button>
          )}
        </div>
      </div>

      {stalled && (
        <Alert className="border-amber-700/50 bg-amber-950/30">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <AlertTitle className="mb-0 text-amber-200">{t('controls.stalledBanner')}</AlertTitle>
          </div>
        </Alert>
      )}

      {/* Stats — 6 cards: Total / Sent / Delivered / Read / Replied / Failed */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label={t('stats.totalRecipients')}
          value={broadcast.total_recipients}
          total={broadcast.total_recipients}
          icon={<Users className="h-4 w-4" />}
          color="bg-muted text-muted-foreground"
        />
        <StatCard
          label={t('stats.sent')}
          value={broadcast.sent_count}
          total={broadcast.total_recipients}
          icon={<Send className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label={t('stats.delivered')}
          value={broadcast.delivered_count}
          total={broadcast.total_recipients}
          icon={<CheckCheck className="h-4 w-4" />}
          color="bg-teal-500/10 text-teal-400"
        />
        <StatCard
          label={t('stats.read')}
          value={broadcast.read_count}
          total={broadcast.total_recipients}
          icon={<Eye className="h-4 w-4" />}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          label={t('stats.replied')}
          value={broadcast.replied_count}
          total={broadcast.total_recipients}
          icon={<MessageCircle className="h-4 w-4" />}
          color="bg-indigo-500/10 text-indigo-400"
        />
        <StatCard
          label={t('stats.failed')}
          value={broadcast.failed_count}
          total={broadcast.total_recipients}
          icon={<AlertCircle className="h-4 w-4" />}
          color="bg-red-500/10 text-red-400"
        />
      </div>

      <FunnelChart steps={funnelSteps} />

      {/* Recipients Table */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-foreground">
            {statusFilter !== 'all'
              ? t('recipientsHeader', { filtered: filteredRecipients.length, total: recipients.length })
              : t('recipientsHeaderAll', { total: recipients.length })}
          </h2>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-muted-foreground hover:bg-muted"
                  />
                }
              >
                <Filter className="h-3.5 w-3.5" />
                {statusFilter === 'all'
                  ? t('allStatuses')
                  : tStatus(getRecipientStatus(statusFilter).label)}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={() => setStatusFilter('all')}
                  className={
                    statusFilter === 'all' ? 'text-primary' : 'text-popover-foreground'
                  }
                >
                  {t('allStatuses')}
                </DropdownMenuItem>
                {RECIPIENT_STATUSES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={
                      statusFilter === s
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    }
                  >
                    {tStatus(getRecipientStatus(s).label)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={recipients.length === 0}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" />
              {t('exportCsv')}
            </Button>
          </div>
        </div>

        {filteredRecipients.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {recipients.length === 0
                ? t('noRecipients')
                : t('noRecipientsFilter')}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">{t('table.contact')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.phone')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.sent')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.delivered')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.read')}</TableHead>
                  <TableHead className="text-muted-foreground">{t('table.error')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRecipients.map((recipient) => {
                  const rStatus = getRecipientStatus(recipient.status);
                  return (
                    <TableRow key={recipient.id} className="border-border">
                      <TableCell className="font-medium text-foreground">
                        {recipient.contact?.name ?? 'Unknown'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.contact?.phone ?? '-'}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}
                        >
                          {tStatus(rStatus.label)}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.sent_at
                          ? new Date(recipient.sent_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.delivered_at
                          ? new Date(recipient.delivered_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {recipient.read_at
                          ? new Date(recipient.read_at).toLocaleString()
                          : '-'}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-xs text-red-400">
                        {recipient.error_message ?? '-'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
