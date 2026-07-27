-- ============================================================
-- Nó "update_contact" nos Fluxos (spec
-- docs/superpowers/specs/2026-07-27-update-contact-node-design.md)
--
-- Copia variáveis capturadas por collect_input (flow_runs.vars) para
-- colunas do contato (name/email/company), para que o funil de
-- qualificação entregue um cadastro completo ao atendimento humano.
--
-- Única mudança de schema: o novo valor no CHECK de
-- flow_nodes.node_type — mesmo padrão drop-and-recreate das
-- migrações 010 e 016. A forma do config vive em JSONB e é
-- verificada pelo validador + tipos TS, não pelo banco.
--
-- Idempotente — seguro rodar mais de uma vez.
-- ============================================================

ALTER TABLE flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'condition',
    'set_tag',
    'update_contact',
    'handoff',
    'http_fetch',
    'end'
  ));
