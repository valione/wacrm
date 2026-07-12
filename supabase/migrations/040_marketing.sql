-- ============================================================
-- 040_marketing.sql — Integrações de marketing + atribuição de origem
--
-- Fundação de dados para o dashboard de marketing (GA4 + Meta Ads +
-- Google Ads, spec 2026-07-11-marketing-dashboard). Esta migração só
-- cria schema; nenhuma rota/UI é adicionada aqui.
--
--   1. `marketing_integrations` — uma linha por (account, platform):
--      credenciais da conta de anúncios/analytics, criptografadas em
--      repouso (AES-256-GCM, formato `iv:ct:tag` — ver
--      `src/lib/whatsapp/encryption.ts`, mesmo padrão usado em
--      `whatsapp_config.access_token` e `webhook_endpoints.secret`).
--      `config` guarda ids não-secretos (property_id do GA4,
--      ad_account_id do Meta, customer_id do Google Ads) que a UI
--      pode exibir sem descriptografar nada.
--   2. `marketing_cache` — snapshot de métricas já buscadas de cada
--      plataforma por período (`7d` / `30d` / `90d`), para não bater
--      na API externa a cada carregamento do dashboard.
--   3. `conversations.ad_referral` / `conversations.site_ref` — dados
--      de atribuição de origem capturados no primeiro contato: clique
--      em anúncio (ad_referral, payload bruto do webhook do
--      WhatsApp/Meta) ou referência de site (site_ref, ex. UTM/click
--      id de um formulário do site).
--
-- RLS
--   Account-scoped, mesmo padrão da 017/035/028: `is_account_member`
--   (SECURITY DEFINER, definido em 017_account_sharing.sql:136) sem
--   `min_role` = qualquer membro pode ler/escrever. Sem
--   diferenciação de papel (viewer vs agent vs admin) porque ainda
--   não há distinção de permissão definida para marketing na spec —
--   revisar quando o fluxo de conexão de integrações ganhar UI.
--
-- Idempotente — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS marketing_integrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ga4', 'meta_ads', 'google_ads')),
  -- Credenciais criptografadas (AES-256-GCM, formato iv:ct:tag de
  -- src/lib/whatsapp/encryption.ts). Nunca exposto ao cliente — o
  -- tipo `MarketingIntegration` em src/types/index.ts não tem este
  -- campo.
  credentials TEXT NOT NULL,
  -- Ids não-secretos (property_id, ad_account_id, customer_id) que a
  -- UI pode exibir diretamente.
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, platform)
);

CREATE INDEX IF NOT EXISTS idx_marketing_integrations_account
  ON marketing_integrations(account_id);

ALTER TABLE marketing_integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketing_integrations_all ON marketing_integrations;
CREATE POLICY marketing_integrations_all ON marketing_integrations
  FOR ALL USING (is_account_member(account_id));

DROP TRIGGER IF EXISTS set_updated_at ON marketing_integrations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON marketing_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS marketing_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  period TEXT NOT NULL, -- '7d' | '30d' | '90d'
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, platform, period)
);

CREATE INDEX IF NOT EXISTS idx_marketing_cache_account
  ON marketing_cache(account_id);

ALTER TABLE marketing_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marketing_cache_all ON marketing_cache;
CREATE POLICY marketing_cache_all ON marketing_cache
  FOR ALL USING (is_account_member(account_id));

-- Atribuição de origem por conversa (capturada no primeiro contato).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ad_referral JSONB,
  ADD COLUMN IF NOT EXISTS site_ref TEXT;
