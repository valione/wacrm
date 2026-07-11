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

// The GET /api/whatsapp/uazapi/instance route reports the Uazapi
// instance's own lifecycle states; `none` is the "no config yet"
// sentinel and doubles as the initial render state so the panel never
// flashes the session-down banner before the first poll returns.
type UazapiStatus =
  | 'none'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'hibernated';

/**
 * QR-code connection panel for the Uazapi provider — a cloud service, so
 * unlike WAHA there is no local engine to keep warm. Rendered inside the
 * WhatsApp settings card body when the Uazapi provider is selected. It
 * owns the instance lifecycle: connect → scan → connected → disconnect.
 *
 * The QR image arrives inline in the status JSON (`qrcode`, a ready-to-use
 * data URL). Uazapi rotates the code through its own status, so a plain 3s
 * status poll re-renders a fresh QR — there's no separate cache-bust timer
 * like the WAHA panel needs.
 *
 * `onChanged` lets the parent (whatsapp-config.tsx) re-run its own
 * /api/whatsapp/config health check whenever the instance flips to
 * connected or is torn down — that's what keeps the provider selector's
 * "disabled/switch-blocked" state honest.
 */
export function WhatsAppUazapiConfig({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations('Settings.uazapi');
  const [status, setStatus] = useState<UazapiStatus>('none');
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  // Tracks whether this number has been connected during this mount so a
  // later drop (disconnected/hibernated) can surface the "session down"
  // banner instead of a plain first-time connect prompt.
  const hadConnectedRef = useRef(false);
  // Fire onChanged only on the connected edge, not on every poll tick.
  const connectedNotifiedRef = useRef(false);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/uazapi/instance');
      if (!res.ok) return;
      const data = await res.json();
      const next: UazapiStatus = data.status ?? 'disconnected';
      setStatus(next);
      setQrcode(data.qrcode ?? null);
      setPhone(data.phone ?? null);
      if (next === 'connected') {
        hadConnectedRef.current = true;
        if (!connectedNotifiedRef.current) {
          connectedNotifiedRef.current = true;
          onChanged?.();
        }
      } else {
        connectedNotifiedRef.current = false;
      }
    } catch {
      // Server unreachable — leave the current state; the connect
      // button surfaces the failure path on the next explicit action.
    }
  }, [onChanged]);

  // While connecting, poll status every 3s. Each poll carries a freshly
  // rotated QR data URL, so re-rendering on the new `qrcode` is all that's
  // needed to keep the code current.
  useEffect(() => {
    if (status !== 'connecting') return;
    const statusTimer = setInterval(() => void refreshStatus(), 3000);
    return () => clearInterval(statusTimer);
  }, [status, refreshStatus]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const connect = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/whatsapp/uazapi/instance', { method: 'POST' });
      if (res.ok) {
        setStatus('connecting');
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
      if (res.status === 409 || payload.error?.endsWith('_config_exists')) {
        // Another provider (meta or waha) already owns a saved config.
        toast.error(t('switchBlocked'));
      } else if (res.status === 502 || payload.error === 'uazapi_unreachable') {
        // Cloud server temporarily unreachable — the backend left state
        // untouched, so just prompt a retry without changing the panel.
        toast.error(t('tryAgain'));
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
      const res = await fetch('/api/whatsapp/uazapi/instance', { method: 'DELETE' });
      if (!res.ok) {
        // Backend couldn't tear the instance/config down — keep the UI
        // on the real (still-connected) state instead of a phantom
        // "disconnected" that would leave the provider selector locked
        // with no explanation.
        toast.error(t('disconnectFailed'));
        return;
      }
      hadConnectedRef.current = false;
      connectedNotifiedRef.current = false;
      setStatus('none');
      setQrcode(null);
      setPhone(null);
      onChanged?.();
    } catch {
      toast.error(t('disconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  };

  // Connected — show the linked number and a disconnect control.
  if (status === 'connected' && phone) {
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

  // Awaiting scan — render the live QR image straight from the status JSON.
  if (status === 'connecting' && qrcode) {
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
            {/* eslint-disable-next-line @next/next/no-img-element -- inline data URL from the status route, not a static asset */}
            <img src={qrcode} alt={t('scanTitle')} width={264} height={264} />
          </div>
          <p className="text-xs text-muted-foreground">{t('qrExpiredHint')}</p>
        </CardContent>
      </Card>
    );
  }

  // Connecting but the QR hasn't landed yet — brief loading state.
  if (status === 'connecting') {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <QrCode className="size-5 text-primary" />
            {t('scanTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('loadingQr')}
        </CardContent>
      </Card>
    );
  }

  // none / disconnected / hibernated — offer to (re)connect. Show the
  // session-down banner only when a live session dropped this session.
  const sessionDown =
    (status === 'disconnected' || status === 'hibernated') && hadConnectedRef.current;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <QrCode className="size-5 text-primary" />
          {t('providerUazapi')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('providerUazapiHint')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {sessionDown && (
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
        <Button onClick={connect} disabled={busy}>
          {busy ? (
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
