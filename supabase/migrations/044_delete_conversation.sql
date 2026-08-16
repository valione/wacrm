-- ============================================================
-- 044_delete_conversation
--
-- Apagar uma conversa pelo app, levando junto os negócios ligados
-- a ela.
--
-- Por que uma função e não dois DELETEs do cliente: `deals` e
-- `conversations` precisam cair juntas. Duas chamadas separadas
-- podem falhar no meio e deixar negócios apagados sob uma conversa
-- que continua de pé — perda silenciosa de oportunidade. Uma função
-- é uma transação: ou vai tudo, ou não vai nada.
--
-- Por que os negócios morrem junto (e não `SET NULL`): decisão do
-- produto. `deals.conversation_id` (001) não tem regra de exclusão,
-- então o Postgres BLOQUEIA o delete da conversa enquanto houver
-- negócio apontando — e a v1.9 passou a criar negócios já ligados à
-- conversa pelo Inbox, tornando esse bloqueio o caso comum.
--
-- SECURITY INVOKER: as políticas de quem chama valem. Nenhuma regra
-- nova de permissão — `conversations_delete` e `deals_delete` (017)
-- já exigem papel `agent`.
--
-- O retorno existe porque a RLS filtra CALADA: sem permissão o
-- DELETE não afeta linha alguma e não levanta erro. Sem devolver a
-- contagem, a interface mostraria "apagado" para quem não apagou
-- nada.
--
-- Cascatas que o banco já resolve: messages, message_actions e
-- notifications somem; flow_runs e registros de IA ficam órfãos
-- (SET NULL), de propósito — o histórico de execução sobrevive.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_conversation_with_deals(
  p_conversation_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM deals WHERE conversation_id = p_conversation_id;
  DELETE FROM conversations WHERE id = p_conversation_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_conversation_with_deals(UUID)
  TO authenticated;
