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
--   `marketing_integrations` é settings-class com segredo
--   criptografado, mesmo perfil de `api_keys` (026) e
--   `webhook_endpoints` (028): SELECT para qualquer membro (viewer+),
--   INSERT/UPDATE/DELETE só admin+ via
--   `is_account_member(account_id, 'admin')` (SECURITY DEFINER,
--   definido em 017_account_sharing.sql:136).
--   `marketing_cache` só tem policy de SELECT (membro): quem escreve
--   é a rota de summary com o client service-role, que bypassa RLS —
--   nenhum usuário escreve nessa tabela diretamente.
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

-- Dropada por segurança caso uma execução anterior desta migração
-- tenha criado a policy FOR ALL antiga (viewer podia escrever).
DROP POLICY IF EXISTS marketing_integrations_all ON marketing_integrations;

-- SELECT: any member of the account (viewer+) can see which
-- integrations are connected. `credentials` is in the table but the
-- dashboard never selects it (the client type omits the field).
DROP POLICY IF EXISTS marketing_integrations_select ON marketing_integrations;
CREATE POLICY marketing_integrations_select ON marketing_integrations FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class, espelhando
-- api_keys/webhook_endpoints — tabelas com segredo criptografado).
DROP POLICY IF EXISTS marketing_integrations_insert ON marketing_integrations;
CREATE POLICY marketing_integrations_insert ON marketing_integrations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS marketing_integrations_update ON marketing_integrations;
CREATE POLICY marketing_integrations_update ON marketing_integrations FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS marketing_integrations_delete ON marketing_integrations;
CREATE POLICY marketing_integrations_delete ON marketing_integrations FOR DELETE
  USING (is_account_member(account_id, 'admin'));

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

-- Dropada por segurança caso uma execução anterior desta migração
-- tenha criado a policy FOR ALL antiga.
DROP POLICY IF EXISTS marketing_cache_all ON marketing_cache;

-- SELECT: any member of the account (viewer+) can read cached
-- metrics. Sem policy de INSERT/UPDATE/DELETE de propósito: quem
-- escreve no cache é a rota de summary usando o client service-role
-- (bypassa RLS); com RLS habilitado e nenhuma policy de escrita,
-- qualquer escrita autenticada direta é negada por padrão.
DROP POLICY IF EXISTS marketing_cache_select ON marketing_cache;
CREATE POLICY marketing_cache_select ON marketing_cache FOR SELECT
  USING (is_account_member(account_id));

-- Atribuição de origem por conversa (capturada no primeiro contato).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ad_referral JSONB,
  ADD COLUMN IF NOT EXISTS site_ref TEXT;
