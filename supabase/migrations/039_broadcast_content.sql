-- ============================================================
-- 039: Transmissões com texto livre + agendamento + processador cron
--
-- Provedores não-oficiais (WAHA/Uazapi) não têm templates; broadcasts
-- deles carregam texto livre (content_text, com placeholders {{...}})
-- e mídia opcional. CHECK garante: template XOR content_text.
-- claimed_at em broadcast_recipients é o lock leve do cron
-- (dois ticks concorrentes não enviam para o mesmo destinatário).
-- Status 'paused' permite pausar/retomar pelo usuário.
--
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

ALTER TABLE broadcasts ALTER COLUMN template_name DROP NOT NULL;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS content_text TEXT,
  ADD COLUMN IF NOT EXISTS content_media_url TEXT,
  ADD COLUMN IF NOT EXISTS content_media_type TEXT
    CHECK (content_media_type IN ('image', 'video', 'document', 'audio'));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'broadcasts_content_coherence'
                   AND conrelid = 'broadcasts'::regclass) THEN
    ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_content_coherence
      CHECK ((template_name IS NOT NULL) <> (content_text IS NOT NULL));
  END IF;
END $$;

-- O CHECK inline de status (001) recebeu o nome padrão do Postgres
-- para constraint sem nome explícito: broadcasts_status_check.
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'failed'));

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Notificação de conclusão de transmissão. O CHECK original (027,
-- ampliado pela 037 para 'whatsapp_disconnected') se chama
-- notifications_type_check.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_disconnected', 'broadcast_finished'));
