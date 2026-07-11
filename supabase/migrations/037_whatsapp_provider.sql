-- 037_whatsapp_provider.sql
-- Segundo provedor de WhatsApp (WAHA). Ver spec 2026-07-10-waha-provider-design.md.

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
    CHECK (provider IN ('meta', 'waha')),
  ADD COLUMN IF NOT EXISTS waha_session TEXT,
  ADD COLUMN IF NOT EXISTS waha_phone TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_waha_session
  ON whatsapp_config(waha_session) WHERE waha_session IS NOT NULL;

-- phone_number_id passa a ser obrigatório SÓ para Meta.
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_meta_requires_phone
  CHECK (provider <> 'meta' OR phone_number_id IS NOT NULL);

-- Notificação de sessão caída (Bloco 2 da spec). O CHECK original (027)
-- só permitia 'conversation_assigned'.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_disconnected'));
