# Fase 2 — Transmissões com texto livre, agendamento e processador em background

**Data:** 2026-07-11
**Status:** aprovado para planejamento de implementação
**Pré-requisitos:** fase 1 WAHA e Uazapi v1 completas (camada de provedores, capacidades,
webhooks com acks alimentando `broadcast_recipients`).

## Objetivo

Transmissões (broadcasts) passam a funcionar para provedores não-oficiais (WAHA e
Uazapi) com **texto livre + mídia opcional + placeholders**, em ritmo anti-banimento,
processadas em **background** (sobrevivem a aba fechada). De carona, **agendamento**
("enviar às 9h de amanhã") para transmissões de qualquer provedor. O caminho Meta
"enviar agora" atual não muda.

## Decisões de produto (aprovadas)

1. **Agendamento incluído** — ativa as colunas dormentes `scheduled_at`/status
   `'scheduled'` para todos os provedores.
2. **Placeholders no texto livre** — `{{nome}}` e campos personalizados
   (ex.: `{{empresa}}`), substituídos por destinatário no envio; mesmo mecanismo de
   fontes do passo 3 do wizard. Bônus anti-ban: mensagens variam entre si.
3. **Arquitetura: processador via cron preservando o caminho Meta imediato**
   (abordagem 1 de 3 avaliadas). "Enviar agora" da Meta continua no loop do
   navegador como hoje; o cron cuida do que é novo: não-oficiais (sempre) e
   agendadas (qualquer provedor). Unificação total no cron fica como refatoração
   futura.
4. **Ritmo:** padrão 10 mensagens/min por conta (env `BROADCAST_RATE_PER_MINUTE`),
   jitter de 1–3s entre envios da fatia, cap existente de 1.000 destinatários.
   Lento de propósito; a UI mostra estimativa de duração e aviso de banimento.
5. **API pública v1 fora de escopo** — continua template-only; extensão futura.

## Banco — migração `039_broadcast_content.sql`

Na tabela `broadcasts`:
- `template_name` deixa de ser NOT NULL.
- Novas colunas: `content_text TEXT`, `content_media_url TEXT`,
  `content_media_type TEXT CHECK (content_media_type IN
  ('image','video','document','audio'))` (todas nullable).
- CHECK de coerência: `(template_name IS NOT NULL) <> (content_text IS NOT NULL)`
  — ou template (Meta) ou texto livre, exatamente um dos dois. Transmissões
  existentes (todas com template) permanecem válidas.
- `status` ganha o valor novo `'paused'` no CHECK (além dos existentes
  draft/scheduled/sending/sent/failed).
- `broadcast_recipients` e os triggers de contadores (migrações 003/005) não mudam
  — o modelo status-por-destinatário + contadores derivados já serve o
  processamento assíncrono.

Idempotente, no padrão do repo. Aplicada via Management API como as anteriores.

## Processador — rota `GET /api/broadcasts/cron`

Autenticação: header `x-cron-secret` == `AUTOMATION_CRON_SECRET` (mesmo padrão e
segredo do cron de automações/flows; o pinger externo de produção só ganha mais
uma URL, 1×/min). Cada tick:

1. **Ativação:** `UPDATE broadcasts SET status='sending' WHERE status='scheduled'
   AND scheduled_at <= now()` (account-agnóstico, service-role).
2. **Fatia:** para cada broadcast `sending` (por conta), reivindica até
   `BROADCAST_RATE_PER_MINUTE` (default 10) destinatários `pending` com **claim
   atômico** (UPDATE condicional marcando um lote com um claim token/timestamp,
   estilo do drain de `automation_pending_executions` — dois ticks concorrentes
   nunca pegam a mesma linha).
3. **Guarda de sessão:** antes de enviar a fatia, health do provedor da conta
   (status da config). Provedor desconectado → **pausa implícita**: não envia,
   não marca falha, loga; destinatários seguem `pending` e o próximo tick tenta
   de novo. Conta que trocou de provedor e o broadcast é de conteúdo incompatível
   (ex.: texto livre com conta agora Meta) → pendentes viram `failed` com
   mensagem clara.
4. **Envio por destinatário:** renderiza placeholders (`renderBroadcastText`:
   `{{nome}}` → nome do contato; `{{<campo>}}` → valor do campo personalizado;
   placeholder sem valor → string vazia) e despacha:
   - broadcast de conteúdo: `provider.sendText` / `provider.sendMedia`
     (mídia com `content_text` renderizado como caption);
   - broadcast de template (Meta agendada): `sendTemplateMessage` com os mesmos
     parâmetros que o caminho atual usa.
   Sucesso → recipient `status='sent'`, `sent_at`, `whatsapp_message_id` (acks
   dos webhooks movem para delivered/read — mecanismo existente). Falha →
   `status='failed'` + `error_message`; não interrompe a fatia. Jitter de 1–3s
   entre envios.
5. **Conclusão:** broadcast sem `pending` restantes → `status='sent'` (≥1
   enviado) ou `'failed'`; INSERT em `notifications` para o dono
   ("Transmissão 'X' concluída: N enviadas, M falhas") — exige ampliar o CHECK
   de `notifications.type` com `'broadcast_finished'` (na migração 039).
6. **Orçamento de tempo:** o tick respeita `maxDuration` da rota (60s) — fatia
   dimensionada para caber (10 envios + jitter ≈ 30s no pior caso).

## Criação e controle — rotas internas

- `POST /api/whatsapp/broadcasts` (nova): cria transmissão de **texto livre**
  (qualquer provedor não-oficial) ou **agendada** (qualquer provedor). Valida:
  capacidades (conta Meta não cria texto livre; conta não-oficial não cria
  template), conteúdo coerente com a CHECK, `scheduled_at` futuro quando
  presente. Resolve a audiência server-side (reusa a lógica de
  all/tags/custom_field/csv do hook atual, movida/compartilhada), grava
  `broadcasts` (status `scheduled` ou `sending`) + `broadcast_recipients`
  (`pending`, lotes de 200) e responde `{broadcast_id}`. Nenhum envio inline.
- `PATCH /api/whatsapp/broadcasts/[id]`: ações `pause` (sending→paused),
  `resume` (paused→sending), `cancel` (pendentes → `failed` com
  "cancelado pelo usuário"; broadcast → `sent` ou `failed` conforme enviados).
- Autz: mesmo padrão de conta das rotas irmãs (getCurrentAccount); RLS já
  limita broadcasts à conta.

## UI

**Wizard (4 passos, adaptado por provedor via capacidades já expostas):**
- Passo 1 — Meta: escolha de template (igual). Não-oficial: **editor de
  mensagem** (textarea + botão de inserir placeholder + anexo de mídia opcional
  + preview em bolha com contato de exemplo).
- Passo 2 — audiência: sem mudança.
- Passo 3 — Meta: igual. Texto livre: revisão dos placeholders detectados e
  mapeamento de fontes (mesmo componente de fontes de dados adaptado).
- Passo 4 — ganha "Enviar agora" vs "Agendar para [data/hora]" (datetime local
  da conta). Pós-clique: caminho cron (não-oficial ou agendado) cria e
  **redireciona para a tela de acompanhamento**; Meta "enviar agora" mantém o
  overlay/loop atual intocado. Aviso permanente para não-oficiais: risco de
  banimento + estimativa ("~N contatos ≈ M min no ritmo seguro").

**Tela de acompanhamento (`broadcasts/[id]`):**
- Polling leve: refetch de contadores a cada 5s enquanto `scheduled|sending|paused`;
  para sozinho em estado terminal.
- Botões Pausar/Retomar/Cancelar (só para transmissões do caminho cron).
- Exibe `scheduled_at` quando agendada.
- Badge/estado `paused` em `src/lib/broadcast-status.ts` e listagem.

**i18n:** todas as strings novas em `messages/en.json` E `messages/pt.json`.

## Erros e resiliência

- Aba fechada/deploy no meio: estado no banco; o cron continua de onde parou.
- Sessão do provedor cai no meio: transmissão espera (pending preservados) e
  retoma sozinha quando a sessão volta; notificação de queda já existe (fase 1).
- Tick concorrente (pinger duplicado): claim atômico impede envio duplicado.
- Destinatário com telefone inválido: falha individual, transmissão segue.
- Sem `AUTOMATION_CRON_SECRET`/pinger configurado: transmissões do caminho cron
  ficam em `sending` sem progresso — a tela de acompanhamento mostra aviso
  quando não há progresso por >5 min ("verifique a configuração do cron; veja
  docs/automations-and-cron.md").

## Testes

- Unitários: `renderBroadcastText` (placeholders, campos ausentes, texto sem
  placeholder); lógica de fatia/claim (mock supabase); guarda de sessão; CHECK
  de coerência da migração (teste de SQL não — validação por aplicação da
  migração); validações do POST (capacidade × conteúdo).
- Regressão: suíte completa; caminho Meta imediato intocado (zero diffs em
  use-broadcast-sending.ts além do desvio de rota no passo 4 — se houver diff,
  justificar).
- Manual: agendar para +2 min com conta WAHA/Uazapi de teste, acompanhar tela
  (polling), pausar/retomar, cancelar; simular sessão caída no meio.

## Fora de escopo

- API pública v1 com texto livre (extensão futura documentada).
- Unificação do "enviar agora" Meta no cron (refatoração futura).
- Variação automática de texto anti-ban (spintax), relatórios de campanha,
  reenvio de falhas em massa.
