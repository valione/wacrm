-- ============================================================
-- 038: Generalização das colunas de provedor + provedor 'uazapi'
--
-- As colunas waha_session/waha_phone (037) valem para qualquer
-- provedor não-Meta: WAHA guarda o nome da sessão; a Uazapi guarda
-- o id da instância (e o token da instância vai criptografado em
-- access_token). Renomear agora evita uma coluna nova por provedor.
--
-- Idempotente — seguro rodar múltiplas vezes (guardas via catálogo).
-- ============================================================

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'whatsapp_config' AND column_name = 'waha_session') THEN
    ALTER TABLE whatsapp_config RENAME COLUMN waha_session TO provider_session;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'whatsapp_config' AND column_name = 'waha_phone') THEN
    ALTER TABLE whatsapp_config RENAME COLUMN waha_phone TO provider_phone;
  END IF;
END $$;

-- O índice único parcial da 037 acompanha o rename automaticamente,
-- mas o nome antigo confunde; recria com nome neutro.
DROP INDEX IF EXISTS idx_whatsapp_config_waha_session;
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_provider_session
  ON whatsapp_config(provider_session) WHERE provider_session IS NOT NULL;

-- Aceita o terceiro provedor. O CHECK inline de coluna criado pela 037
-- (ADD COLUMN provider ... CHECK (...)) recebeu o nome padrão do
-- Postgres para constraint sem nome explícito: <tabela>_<coluna>_check.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'waha', 'uazapi'));
