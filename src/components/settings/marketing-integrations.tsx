'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  BarChart3,
  CheckCircle2,
  Loader2,
  LineChart,
  Megaphone,
  Trash2,
  type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

// Platforms the backend accepts today (POST /api/marketing/integrations).
// Google Ads is design-reserved ("leva 2") — its card renders disabled.
type MarketingPlatform = 'ga4' | 'meta_ads';

interface IntegrationRow {
  platform: string;
  config: Record<string, unknown>;
}

/**
 * Settings → Marketing integrations panel. One card per ad/analytics
 * platform: paste-credentials form when unconfigured, a "connected"
 * summary (non-secret config only — credentials are NEVER echoed back;
 * the GET route doesn't even return them) with a Remove action once
 * saved. POST validates against the real provider before persisting, so
 * a 422 here carries the platform's own error message — we surface it
 * verbatim in a toast.
 */
export function MarketingIntegrations() {
  const t = useTranslations('Settings.marketing');

  // null = not configured; object = the non-secret config on record.
  const [configured, setConfigured] = useState<
    Record<MarketingPlatform, Record<string, unknown> | null>
  >({ ga4: null, meta_ads: null });
  const [loading, setLoading] = useState(true);

  // GA4 form
  const [ga4Json, setGa4Json] = useState('');
  const [ga4PropertyId, setGa4PropertyId] = useState('');
  // Meta Ads form
  const [metaToken, setMetaToken] = useState('');
  const [metaAdAccountId, setMetaAdAccountId] = useState('');

  const [saving, setSaving] = useState<MarketingPlatform | null>(null);
  const [removing, setRemoving] = useState<MarketingPlatform | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/marketing/integrations', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as IntegrationRow[];
      const next: Record<MarketingPlatform, Record<string, unknown> | null> = {
        ga4: null,
        meta_ads: null,
      };
      for (const row of rows) {
        if (row.platform === 'ga4' || row.platform === 'meta_ads') {
          next[row.platform] = row.config ?? {};
        }
      }
      setConfigured(next);
    } catch {
      toast.error(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (platform: MarketingPlatform) => {
    const body =
      platform === 'ga4'
        ? {
            platform,
            credentials: { serviceAccountJson: ga4Json.trim() },
            config: { propertyId: ga4PropertyId.trim() },
          }
        : {
            platform,
            credentials: { accessToken: metaToken.trim() },
            config: { adAccountId: metaAdAccountId.trim() },
          };

    const missing =
      platform === 'ga4'
        ? !ga4Json.trim() || !ga4PropertyId.trim()
        : !metaToken.trim() || !metaAdAccountId.trim();
    if (missing) {
      toast.error(t('fillAllFields'));
      return;
    }

    setSaving(platform);
    try {
      const res = await fetch('/api/marketing/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as IntegrationRow;
        setConfigured((prev) => ({ ...prev, [platform]: data.config ?? {} }));
        // Clear the credential fields — they should never linger in the
        // DOM once saved (and the configured card never shows them back).
        if (platform === 'ga4') {
          setGa4Json('');
          setGa4PropertyId('');
        } else {
          setMetaToken('');
          setMetaAdAccountId('');
        }
        toast.success(t('saved'));
        return;
      }
      // 422 carries the provider's own validation message; 403 the
      // admin-only message — both are already user-readable, so show
      // them as-is and only fall back to a generic string without one.
      let payload: { error?: string } = {};
      try {
        payload = await res.json();
      } catch {
        /* non-JSON body */
      }
      toast.error(payload.error || t('saveError'));
    } catch {
      toast.error(t('saveError'));
    } finally {
      setSaving(null);
    }
  };

  const remove = async (platform: MarketingPlatform) => {
    if (!confirm(t('removeConfirm'))) return;
    setRemoving(platform);
    try {
      const res = await fetch('/api/marketing/integrations', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform }),
      });
      if (!res.ok) {
        let payload: { error?: string } = {};
        try {
          payload = await res.json();
        } catch {
          /* non-JSON body */
        }
        toast.error(payload.error || t('removeError'));
        return;
      }
      setConfigured((prev) => ({ ...prev, [platform]: null }));
      toast.success(t('removed'));
    } catch {
      toast.error(t('removeError'));
    } finally {
      setRemoving(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('description')}</p>
      </div>

      {/* GA4 */}
      <PlatformCard
        icon={LineChart}
        title={t('ga4Title')}
        description={t('ga4Desc')}
        configured={configured.ga4}
        configuredLabel={t('ga4ConfiguredAs', {
          propertyId: String(configured.ga4?.propertyId ?? ''),
        })}
        credentialsNote={t('credentialsNote')}
        onRemove={() => remove('ga4')}
        removing={removing === 'ga4'}
        removeLabel={t('remove')}
        removingLabel={t('removing')}
      >
        <div className="space-y-2">
          <Label htmlFor="mkt-ga4-json">{t('serviceAccountJson')}</Label>
          <Textarea
            id="mkt-ga4-json"
            value={ga4Json}
            onChange={(e) => setGa4Json(e.target.value)}
            placeholder={t('serviceAccountJsonPlaceholder')}
            rows={6}
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">{t('serviceAccountJsonHint')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="mkt-ga4-property">{t('propertyId')}</Label>
          <Input
            id="mkt-ga4-property"
            value={ga4PropertyId}
            onChange={(e) => setGa4PropertyId(e.target.value)}
            placeholder="123456789"
            autoComplete="off"
          />
        </div>
        <SaveButton
          onClick={() => save('ga4')}
          saving={saving === 'ga4'}
          label={t('save')}
          savingLabel={t('validating')}
        />
      </PlatformCard>

      {/* Meta Ads */}
      <PlatformCard
        icon={Megaphone}
        title={t('metaTitle')}
        description={t('metaDesc')}
        configured={configured.meta_ads}
        configuredLabel={t('metaConfiguredAs', {
          adAccountId: String(configured.meta_ads?.adAccountId ?? ''),
        })}
        credentialsNote={t('credentialsNote')}
        onRemove={() => remove('meta_ads')}
        removing={removing === 'meta_ads'}
        removeLabel={t('remove')}
        removingLabel={t('removing')}
      >
        <div className="space-y-2">
          <Label htmlFor="mkt-meta-token">{t('accessToken')}</Label>
          <Input
            id="mkt-meta-token"
            type="password"
            value={metaToken}
            onChange={(e) => setMetaToken(e.target.value)}
            placeholder={t('accessTokenPlaceholder')}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">{t('accessTokenHint')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="mkt-meta-account">{t('adAccountId')}</Label>
          <Input
            id="mkt-meta-account"
            value={metaAdAccountId}
            onChange={(e) => setMetaAdAccountId(e.target.value)}
            placeholder="1234567890"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">{t('adAccountIdHint')}</p>
        </div>
        <SaveButton
          onClick={() => save('meta_ads')}
          saving={saving === 'meta_ads'}
          label={t('save')}
          savingLabel={t('validating')}
        />
      </PlatformCard>

      {/* Google Ads — leva 2, card presente porém desabilitado. */}
      <Card className="opacity-60">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <BarChart3 className="size-5 text-muted-foreground" />
            {t('googleAdsTitle')}
            <Badge variant="outline">{t('comingSoon')}</Badge>
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('googleAdsDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button disabled>{t('save')}</Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------

function PlatformCard({
  icon: Icon,
  title,
  description,
  configured,
  configuredLabel,
  credentialsNote,
  onRemove,
  removing,
  removeLabel,
  removingLabel,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  configured: Record<string, unknown> | null;
  configuredLabel: string;
  credentialsNote: string;
  onRemove: () => void;
  removing: boolean;
  removeLabel: string;
  removingLabel: string;
  children: React.ReactNode;
}) {
  if (configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <CheckCircle2 className="size-5 text-primary" />
            {title}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {configuredLabel}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">{credentialsNote}</p>
          <Button
            variant="outline"
            onClick={onRemove}
            disabled={removing}
            className="border-red-900 text-red-400 hover:bg-red-950/40 hover:text-red-300"
          >
            {removing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {removingLabel}
              </>
            ) : (
              <>
                <Trash2 className="size-4" />
                {removeLabel}
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Icon className="size-5 text-primary" />
          {title}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function SaveButton({
  onClick,
  saving,
  label,
  savingLabel,
}: {
  onClick: () => void;
  saving: boolean;
  label: string;
  savingLabel: string;
}) {
  return (
    <Button onClick={onClick} disabled={saving}>
      {saving ? (
        <>
          <Loader2 className="size-4 animate-spin" />
          {savingLabel}
        </>
      ) : (
        label
      )}
    </Button>
  );
}
