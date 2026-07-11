-- ============================================================
-- whatsapp_config: segundo provedor de WhatsApp (WAHA)
--
-- Até aqui toda conexão era Meta Cloud API e `phone_number_id` era
-- NOT NULL. Esta migração introduz o provedor WAHA (sessão via QR
-- code), que não tem phone_number_id — ele identifica a conexão por
-- `waha_session` (nome da sessão no servidor WAHA, único) e registra
-- em `waha_phone` o número vinculado após o pareamento.
--
-- `phone_number_id` passa a ser obrigatório SÓ para provider='meta'
-- (constraint whatsapp_config_meta_requires_phone). Linhas existentes
-- recebem provider='meta' pelo DEFAULT, então nada quebra.
--
-- Também amplia o CHECK de notifications.type (o original, da 027,
-- só permitia 'conversation_assigned') para aceitar
-- 'whatsapp_disconnected' — notificação de sessão caída (Bloco 2 da
-- spec 2026-07-10-waha-provider-design.md).
--
-- Idempotente — safe to run multiple times: ADD COLUMN / CREATE INDEX
-- usam IF NOT EXISTS; as constraints são guardadas via pg_constraint
-- ou recriadas com DROP IF EXISTS + ADD.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'waha')),
  ADD COLUMN IF NOT EXISTS waha_session TEXT,
  ADD COLUMN IF NOT EXISTS waha_phone TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_waha_session
  ON whatsapp_config(waha_session) WHERE waha_session IS NOT NULL;

-- phone_number_id passa a ser obrigatório SÓ para Meta. PostgreSQL
-- não tem "ADD CONSTRAINT IF NOT EXISTS", então guard via
-- pg_constraint (mesmo padrão da 013).
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'whatsapp_config_meta_requires_phone'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_meta_requires_phone
      CHECK (provider <> 'meta' OR phone_number_id IS NOT NULL);
  END IF;
END $$;

-- Notificação de sessão caída (Bloco 2 da spec). O CHECK original (027)
-- só permitia 'conversation_assigned'. DROP + ADD é idempotente aqui.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_disconnected'));
