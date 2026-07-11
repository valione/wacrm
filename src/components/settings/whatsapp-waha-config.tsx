'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Loader2,
  QrCode,
  CheckCircle2,
  LogOut,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertTitle } from '@/components/ui/alert';

// The GET /api/whatsapp/waha/session route reports WAHA's own engine
// states; `IDLE` is a client-only sentinel for "not loaded / just
// disconnected" so the initial render doesn't flash the error banner.
type WahaStatus =
  | 'IDLE'
  | 'STARTING'
  | 'SCAN_QR_CODE'
  | 'WORKING'
  | 'STOPPED'
  | 'FAILED';

/**
 * QR-code connection panel for the WAHA provider. Rendered inside the
 * WhatsApp settings card body when the WAHA provider is selected. It
 * owns the session lifecycle: start → scan → working → disconnect,
 * polling status while the user scans and busting the QR cache so the
 * image never goes stale.
 *
 * `onChanged` lets the parent (whatsapp-config.tsx) re-run its own
 * /api/whatsapp/config health check whenever the session flips to
 * WORKING or is torn down — that's what keeps the provider selector's
 * "disabled/switch-blocked" state honest.
 */
export function WhatsAppWahaConfig({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations('Settings.waha');
  const [status, setStatus] = useState<WahaStatus>('IDLE');
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [qrBust, setQrBust] = useState(0);
  // Fire onChanged only on the WORKING edge, not on every poll tick.
  const workingNotifiedRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/waha/session');
      if (!res.ok) return;
      const data = await res.json();
      const next: WahaStatus = data.status ?? 'STOPPED';
      setStatus(next);
      setPhone(data.phone ?? null);
      if (next === 'WORKING') {
        if (!workingNotifiedRef.current) {
          workingNotifiedRef.current = true;
          onChanged?.();
        }
      } else {
        workingNotifiedRef.current = false;
      }
    } catch {
      // Server unreachable — leave the current state; the connect
      // button surfaces the failure path on the next explicit action.
    }
  }, [onChanged]);

  // While waiting for the scan, poll status every 3s and refresh the QR
  // image every 20s (WAHA rotates the code on roughly that cadence).
  useEffect(() => {
    if (status !== 'SCAN_QR_CODE' && status !== 'STARTING') return;
    const statusTimer = setInterval(() => void refreshStatus(), 3000);
    const qrTimer = setInterval(() => setQrBust((n) => n + 1), 20000);
    return () => {
      clearInterval(statusTimer);
      clearInterval(qrTimer);
    };
  }, [status, refreshStatus]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const connect = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/whatsapp/waha/session', { method: 'POST' });
      if (res.ok) {
        setStatus('STARTING');
        setQrBust((n) => n + 1);
        await refreshStatus();
        return;
      }
      // Map the route's typed errors onto specific hints.
      let payload: { error?: string } = {};
      try {
        payload = await res.json();
      } catch {
        /* non-JSON body */
      }
      if (res.status === 409 || payload.error === 'meta_config_exists') {
        toast.error(t('metaConfigExists'));
      } else {
        toast.error(t('connectError'));
      }
    } catch {
      toast.error(t('connectError'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm(t('disconnectConfirm'))) return;
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/waha/session', { method: 'DELETE' });
      if (!res.ok) {
        // Backend couldn't tear the session/config down — keep the UI
        // on the real (still-connected) state instead of a phantom
        // "disconnected" that would leave the provider selector locked
        // with no explanation.
        toast.error(t('disconnectFailed'));
        return;
      }
      workingNotifiedRef.current = false;
      setStatus('IDLE');
      setPhone(null);
      onChanged?.();
    } catch {
      toast.error(t('disconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  };

  // Connected — show the linked number and a disconnect control.
  if (status === 'WORKING' && phone) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <CheckCircle2 className="size-5 text-primary" />
            {t('connectedAs', { phone: `+${phone}` })}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('banWarning')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={disconnect}
            disabled={disconnecting}
            className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
          >
            {disconnecting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('disconnecting')}
              </>
            ) : (
              <>
                <LogOut className="size-4" />
                {t('disconnect')}
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Awaiting scan — render the live QR image.
  if (status === 'SCAN_QR_CODE') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <QrCode className="size-5 text-primary" />
            {t('scanTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('scanHint')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="inline-flex rounded-lg bg-white p-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- dynamic PNG served by an internal route, not a static asset */}
            <img
              src={`/api/whatsapp/waha/session/qr?t=${qrBust}`}
              alt={t('scanTitle')}
              width={264}
              height={264}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('qrExpiredHint')}</p>
        </CardContent>
      </Card>
    );
  }

  // IDLE / STARTING / STOPPED / FAILED — offer to (re)connect.
  const starting = busy || status === 'STARTING';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <QrCode className="size-5 text-primary" />
          {t('providerWaha')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('providerWahaHint')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(status === 'STOPPED' || status === 'FAILED') && (
          <Alert className="bg-amber-950/30 border-amber-700/50">
            <div className="flex items-start gap-2">
              <AlertTriangle className="size-4 text-amber-400 mt-0.5 shrink-0" />
              <div>
                <AlertTitle className="text-amber-200 mb-0">
                  {t('sessionDown')}
                </AlertTitle>
              </div>
            </div>
          </Alert>
        )}
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t('banWarning')}
        </p>
        <Button onClick={connect} disabled={starting}>
          {starting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t('connecting')}
            </>
          ) : (
            <>
              <QrCode className="size-4" />
              {t('connect')}
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
