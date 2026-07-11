# Fase 2 — Transmissões: texto livre, agendamento e processador cron

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transmissões com texto livre + placeholders + mídia para contas WAHA/Uazapi e agendamento para todos os provedores, processadas em background por um cron — sem tocar no "enviar agora" da Meta.

**Architecture:** Migração 039 adiciona conteúdo livre a `broadcasts` (CHECK: template XOR texto) e `claimed_at` a `broadcast_recipients`. Rota `GET /api/broadcasts/cron` (mesmo segredo/pinger do cron de automações) ativa agendadas e processa fatias de destinatários com claim atômico em duas etapas (padrão de `src/app/api/automations/cron/route.ts`), despachando pela camada de provedores existente. Rotas internas novas criam/pausam/retomam/cancelam; o wizard adapta o passo 1 por capacidade e o passo 4 ganha data/hora. Spec: `docs/superpowers/specs/2026-07-11-broadcasts-fase2-design.md`.

**Tech Stack:** Next.js 16 (App Router), Supabase (triggers de contadores das migrações 003/005 permanecem donos dos counts), TypeScript, vitest.

## Global Constraints

- **Meta "enviar agora" intocado:** `src/hooks/use-broadcast-sending.ts` e `POST /api/whatsapp/broadcast` (singular) não mudam de comportamento; a única mudança permitida no fluxo atual é o desvio de rota no passo 4 do wizard para os casos novos (não-oficial ou agendado).
- **Contadores são do banco:** NUNCA escrever `sent_count`/`delivered_count`/etc. — o trigger incremental (`005_broadcast_counts_incremental.sql`) deriva tudo do status dos recipients (comentários em `broadcast-core.ts:188-195` explicam).
- Critérios permanentes por task: `npx vitest run` sem falhas novas (2 pré-existentes conhecidas: date-utils/mondayIndex), `npm run typecheck`, `npm run lint`.
- Next.js 16: consultar `node_modules/next/dist/docs/` antes de mexer em rotas (AGENTS.md).
- i18n em paridade: strings novas em `messages/en.json` E `messages/pt.json` (check de paridade por task de UI).
- Ritmo: `BROADCAST_RATE_PER_MINUTE` (default 10) por conta; jitter 1–3s entre envios; cap `MAX_RECIPIENTS = 1000` existente.
- Cron autenticado por `x-cron-secret` == `AUTOMATION_CRON_SECRET` (mesmo env; 503 sem env, 401 com segredo errado — padrão exato de `automations/cron/route.ts:18-25`).
- Migrações aplicadas via Management API (token pedido ao usuário; nunca commitá-lo) e registradas em `supabase_migrations.schema_migrations`.
- Commits no branch `personalizacao-display4`, mensagens em português, rodapé `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Migração 039 — conteúdo livre, paused e claim

**Files:**
- Create: `supabase/migrations/039_broadcast_content.sql`
- Modify: `src/types/index.ts` (interfaces `Broadcast` linha ~390 e `BroadcastRecipient` linha ~409)

**Interfaces:**
- Produces: colunas `broadcasts.content_text|content_media_url|content_media_type`, status `'paused'`, `broadcast_recipients.claimed_at`; CHECK de notifications com `'broadcast_finished'`; tipos atualizados.

- [ ] **Step 1: Escrever a migração**

```sql
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

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'failed'));

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

-- Notificação de conclusão de transmissão.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'whatsapp_disconnected', 'broadcast_finished'));
```

Atenção: conferir os nomes reais dos CHECKs de `broadcasts.status` e `broadcasts.content_media_type` no catálogo/migração 001 (CHECK inline de coluna → `broadcasts_status_check` por convenção; validar antes do DROP, como feito nas migrações 037/038).

- [ ] **Step 2: Atualizar tipos**

Em `src/types/index.ts`: `Broadcast` ganha `content_text?: string | null; content_media_url?: string | null; content_media_type?: 'image' | 'video' | 'document' | 'audio' | null;`, `template_name` vira `string | null`, e o union de `status` ganha `'paused'`. `BroadcastRecipient` ganha `claimed_at?: string | null;`.

- [ ] **Step 3: Validar** — `npm run typecheck` (se acusar call sites que assumem `template_name` não-nulo, adicionar `!` apenas em caminhos comprovadamente template-only e listar no relatório); `npx vitest run`; `npm run lint`.

- [ ] **Step 4: Aplicar no Supabase remoto** (controlador, Management API) e registrar `('039','039_broadcast_content')`.

- [ ] **Step 5: Commit** — `feat: migração 039 — transmissões com texto livre, paused e claim do cron`

---

### Task 2: Renderizador de placeholders

**Files:**
- Create: `src/lib/broadcasts/render.ts`
- Test: `src/lib/broadcasts/render.test.ts`

**Interfaces:**
- Produces: `renderBroadcastText(template: string, contact: { name?: string | null; customValues?: Record<string, string | null> }): string`

- [ ] **Step 1: Teste que falha**

```typescript
// src/lib/broadcasts/render.test.ts
import { describe, it, expect } from 'vitest'
import { renderBroadcastText } from './render'

describe('renderBroadcastText', () => {
  it('substitui {{nome}} pelo nome do contato', () => {
    expect(renderBroadcastText('Oi {{nome}}, tudo bem?', { name: 'Maria' }))
      .toBe('Oi Maria, tudo bem?')
  })
  it('substitui campos personalizados', () => {
    expect(renderBroadcastText('Sua empresa {{empresa}} foi aprovada', {
      name: 'Ana', customValues: { empresa: 'ACME' },
    })).toBe('Sua empresa ACME foi aprovada')
  })
  it('placeholder sem valor vira string vazia', () => {
    expect(renderBroadcastText('Oi {{nome}} da {{empresa}}', { name: null }))
      .toBe('Oi  da ')
  })
  it('é case-insensitive na chave e tolera espaços internos', () => {
    expect(renderBroadcastText('Oi {{ Nome }}', { name: 'Bia' })).toBe('Oi Bia')
  })
  it('texto sem placeholder passa intacto', () => {
    expect(renderBroadcastText('Promoção hoje!', {})).toBe('Promoção hoje!')
  })
  it('chaves não fechadas não explodem', () => {
    expect(renderBroadcastText('Oi {{nome', { name: 'X' })).toBe('Oi {{nome')
  })
})
```

- [ ] **Step 2: Ver falhar** — `npx vitest run src/lib/broadcasts/render.test.ts` → módulo inexistente.

- [ ] **Step 3: Implementar**

```typescript
// src/lib/broadcasts/render.ts
// Renderiza placeholders {{chave}} do texto livre de transmissões.
// 'nome' (e 'name') resolvem para contact.name; qualquer outra chave
// resolve para customValues[chave]. Sem valor → string vazia, para a
// mensagem nunca vazar um "{{empresa}}" cru para o cliente.

export function renderBroadcastText(
  template: string,
  contact: { name?: string | null; customValues?: Record<string, string | null> },
): string {
  return template.replace(/\{\{\s*([\wÀ-ſ]+)\s*\}\}/g, (_m, rawKey: string) => {
    const key = rawKey.toLowerCase()
    if (key === 'nome' || key === 'name') return contact.name ?? ''
    return contact.customValues?.[key] ?? contact.customValues?.[rawKey] ?? ''
  })
}
```

- [ ] **Step 4: Ver passar** + typecheck + lint.
- [ ] **Step 5: Commit** — `feat: renderizador de placeholders para transmissões de texto livre`

---

### Task 3: Rotas de criação e controle

**Files:**
- Create: `src/app/api/whatsapp/broadcasts/route.ts` (POST)
- Create: `src/app/api/whatsapp/broadcasts/[id]/route.ts` (PATCH)
- Create: `src/lib/broadcasts/audience.ts` (resolução server-side de audiência)

**Interfaces:**
- Consumes: `getCurrentAccount` (padrão das rotas uazapi/waha), `CAPABILITIES` de `@/lib/whatsapp/providers/resolve`.
- Produces (consumido pela UI, Tasks 5-6):
  - `POST /api/whatsapp/broadcasts` body: `{ name: string, content_text?: string, content_media_url?: string, content_media_type?: 'image'|'video'|'document'|'audio', template_name?: string, template_language?: string, template_variables?: object, audience: { type: 'all'|'tags'|'custom_field'|'contact_ids', tagIds?: string[], excludeTagIds?: string[], field?: string, value?: string, contactIds?: string[] }, scheduled_at?: string }` → `201 {broadcast_id}`.
    Validações: conta sem config → 409; conteúdo livre exige `!capabilities.supportsTemplates` do provedor da conta (Meta não cria texto livre → 422 `unsupported_by_provider`); template exige `supportsTemplates` (não-oficial não cria template → 422); template SEM `scheduled_at` → 422 com mensagem "envio imediato de template usa o fluxo atual" (o caminho imediato Meta continua no hook); XOR de conteúdo espelhando a CHECK; `scheduled_at` no passado → 422; audiência resolvida server-side com cap 1000 (acima → 422); grava `broadcasts` (status `'scheduled'` se `scheduled_at`, senão `'sending'`) + `broadcast_recipients` `'pending'` em lotes de 200.
  - `PATCH /api/whatsapp/broadcasts/[id]` body `{action: 'pause'|'resume'|'cancel'}`: pause = `sending→paused`; resume = `paused|scheduled→sending` (resume de scheduled = "enviar agora"); cancel = pendentes → `failed` com `error_message: 'cancelado pelo usuário'` + broadcast → `'sent'` se `sent_count>0` senão `'failed'`. Transição inválida → 409.
  - `resolveAudienceServer(db, accountId, audience): Promise<string[]>` (ids de contatos, deduplicados) — adaptação server-side da lógica de `src/hooks/use-broadcast-sending.ts` (`resolveAudience`, linhas ~219-288): `all` = todos os contatos da conta; `tags` = contatos com qualquer das tagIds, menos excludeTagIds; `custom_field` = igualdade em `contact_custom_values`; `contact_ids` = lista explícita validada contra a conta (o fluxo CSV do wizard faz o upsert no navegador como hoje e envia os ids).

- [ ] **Step 1: Implementar `audience.ts`** lendo primeiro o `resolveAudience` do hook (mesmas tabelas/filtros, trocando o client do browser pelo server client passado por parâmetro). Sem teste unitário próprio (query-building sobre Supabase; padrão do repo não mocka o client) — validação via typecheck + E2E; registrar no relatório.
- [ ] **Step 2: Implementar POST e PATCH** com as validações acima (espelhar formato de erro das rotas irmãs uazapi/waha).
- [ ] **Step 3: Validar** — suíte, typecheck, lint.
- [ ] **Step 4: Commit** — `feat: rotas de criação e controle de transmissões do processador`

---

### Task 4: Processador — `src/lib/broadcasts/processor.ts` + rota cron

**Files:**
- Create: `src/lib/broadcasts/processor.ts`
- Create: `src/app/api/broadcasts/cron/route.ts`
- Test: `src/lib/broadcasts/processor.test.ts` (helpers puros)

**Interfaces:**
- Consumes: `resolveProvider`/`CAPABILITIES`, `sendTemplateMessage` (meta-api), `renderBroadcastText` (Task 2), `decrypt`, `supabaseAdmin`, `phoneVariants`/`sanitizePhoneForMeta`/`isRecipientNotAllowedError` (padrão dos senders existentes — ver `broadcast-core.ts:262-327` como gabarito do loop Meta).
- Produces: `runBroadcastTick(): Promise<{activated: number, processed: number, completed: number}>` — chamado pela rota cron.

- [ ] **Step 1: Testes dos helpers puros que falham**

```typescript
// src/lib/broadcasts/processor.test.ts — casos:
// 1. sliceBudget(rate, elapsedMsBudget): calcula quantos envios cabem no tick
//    (rate default 10; nunca menos que 1)
// 2. jitterMs(): retorna entre 1000 e 3000 (rodar 100x e verificar range)
// 3. isBroadcastComplete(counts): pending===0 → true
// 4. finalStatus({sentCount}): >0 → 'sent'; 0 → 'failed'
```

Escrever os testes completos (imports, describe/it, asserts concretos) no padrão vitest do repo.

- [ ] **Step 2: Ver falhar; implementar `processor.ts`:**

```typescript
// Estrutura (implementar por completo, com os detalhes abaixo):
export async function runBroadcastTick() {
  const admin = supabaseAdmin()
  // 1. ATIVAÇÃO: update broadcasts set status='sending'
  //    where status='scheduled' and scheduled_at <= now()  (select count p/ retorno)
  // 2. SELEÇÃO: broadcasts com status='sending' (select colunas de conteúdo + account_id, user_id)
  // 3. Por broadcast (sequencial):
  //    a. Config da conta: select * from whatsapp_config where account_id = ...
  //       - sem config → pendentes viram failed('provedor desconectado') e broadcast finaliza
  //       - conteúdo incompatível com o provedor atual (texto livre + provider meta,
  //         ou template + provider não-oficial) → pendentes failed('provedor da conta mudou'), finaliza
  //       - config.status !== 'connected' → PULA o broadcast neste tick (pausa implícita; log)
  //    b. CLAIM (duas etapas, padrão automations/cron): select id from broadcast_recipients
  //       where broadcast_id=... and status='pending'
  //         and (claimed_at is null or claimed_at < now()-interval '5 minutes')
  //       order by created_at limit RATE;
  //       depois update ... set claimed_at=now() where id in (...) and status='pending'
  //       (o and status='pending' é o lock; ids que outro tick pegou não voltam do update)
  //    c. ENVIO por recipient claimed: carregar contato (nome, phone) + custom values
  //       (uma query batch para a fatia); para conteúdo livre:
  //         renderBroadcastText + provider.sendText / provider.sendMedia
  //         (mídia: content_media_url + caption = texto renderizado)
  //       para template (Meta agendada): sendTemplateMessage com template_name/language/variables
  //         + retry de phoneVariants (copiar o padrão de broadcast-core.ts deliverBroadcast)
  //       sucesso → status='sent', sent_at, whatsapp_message_id, claimed_at=null
  //       falha → status='failed', error_message (sem abortar a fatia)
  //       jitter: await sleep(1000 + Math.random()*2000) entre envios
  //    d. CONCLUSÃO: count de pending restantes === 0 →
  //       status final por finalStatus() + INSERT notifications
  //       {account_id, user_id: broadcast.user_id, type: 'broadcast_finished',
  //        title: `Transmissão "${name}" concluída`,
  //        body: `${sent} enviadas, ${failed} falhas`}
  // 4. Retorno {activated, processed, completed}
}
```

Decisões fixas: tokens descriptografados com a expressão padrão `config.provider === 'waha' ? null : decrypt(config.access_token)` + `resolveProvider`; orçamento do tick = processar no máximo `BROADCAST_RATE_PER_MINUTE` envios por conta e retornar (rota tem `export const maxDuration = 60`).

- [ ] **Step 3: Rota cron** — cópia do esqueleto de autenticação de `src/app/api/automations/cron/route.ts:17-26` (503 sem env, 401 errado) chamando `runBroadcastTick()` e retornando o resumo.
- [ ] **Step 4: Validar** — testes novos PASS, suíte completa, typecheck, lint.
- [ ] **Step 5: Commit** — `feat: processador cron de transmissões (ativação, fatia com claim, envio com jitter, conclusão)`

---

### Task 5: Wizard — editor de texto livre e agendamento

**Files:**
- Create: `src/components/broadcasts/step1-compose-message.tsx`
- Modify: `src/app/(dashboard)/broadcasts/new/page.tsx` (orquestração por capacidade + submit novo)
- Modify: `src/components/broadcasts/step3-personalize.tsx` (modo texto livre: revisão dos placeholders detectados)
- Modify: `src/components/broadcasts/step4-schedule-send.tsx` (campo de agendamento + estimativa + aviso)
- Modify: `messages/en.json`, `messages/pt.json` (namespace `Broadcasts.compose` e `Broadcasts.schedule`)

**Interfaces:**
- Consumes: `useProviderCapabilities` (hook existente de `@/lib/whatsapp/use-provider-capabilities`), `POST /api/whatsapp/broadcasts` (Task 3).
- Produces: fluxo completo de criação para contas não-oficiais e agendamento para todas.

Diretivas (o implementador estuda os componentes atuais antes — são o gabarito de estilo):
- `step1-compose-message.tsx`: renderizado no passo 1 quando `capabilities.supportsTemplates === false`. Textarea com contador; botões de inserção de placeholder (`{{nome}}` + um por campo personalizado da conta — buscar de `custom_fields` como o step3 atual faz); anexo de mídia opcional (URL pública ou upload se houver util pronto no repo — usar o mecanismo do composer do inbox se existir, senão campo de URL com preview); preview em bolha com contato de exemplo.
- `new/page.tsx`: o array de steps troca o passo 1 conforme capacidade; o submit final decide a rota: (a) conta não-oficial OU `scheduled_at` preenchido → `POST /api/whatsapp/broadcasts` + `router.push('/broadcasts/'+id)`; (b) Meta imediato → fluxo atual do hook, intocado.
- `step4-schedule-send.tsx`: toggle "Enviar agora" / "Agendar" com `<input type="datetime-local">` (mínimo agora+5min); estimativa de duração para não-oficiais (`Math.ceil(total / RATE)` minutos, RATE vindo de env público? — não: fixar 10/min na cópia da UI e mencionar "ritmo seguro"); aviso de banimento permanente para não-oficiais (reusar tom das strings `Settings.waha.banWarning`).
- i18n: paridade en/pt obrigatória (check node -e).

- [ ] **Step 1: Implementar** conforme diretivas. **Step 2: Validar** — build/dev compila, suíte, typecheck, lint, paridade i18n. **Step 3: Commit** — `feat: wizard de transmissão com editor de texto livre e agendamento`

---

### Task 6: Tela de acompanhamento — polling e controles

**Files:**
- Modify: `src/app/(dashboard)/broadcasts/[id]/page.tsx` (polling + botões)
- Modify: `src/lib/broadcast-status.ts` (badge `paused` + `scheduled`)
- Modify: `messages/en.json`, `messages/pt.json`

**Interfaces:**
- Consumes: `PATCH /api/whatsapp/broadcasts/[id]` (Task 3).

Diretivas:
- Polling: `setInterval` de 5s refazendo o fetch existente enquanto `['scheduled','sending','paused'].includes(status)`; `clearInterval` no cleanup e quando entrar em estado terminal.
- Botões Pausar/Retomar/Cancelar (Cancelar com `confirm()`), visíveis apenas para transmissões do caminho cron (`content_text !== null || scheduled_at !== null`); erros → toast (padrão do repo).
- Exibir `scheduled_at` formatado quando status `scheduled`; aviso "sem progresso há mais de 5 min — verifique a configuração do cron (docs/automations-and-cron.md)" quando `sending` sem mudança de contadores por 5 min (comparação no cliente entre polls).
- Badge `paused` (e uso real do `scheduled`) em `broadcast-status.ts` + listagem.

- [ ] **Step 1: Implementar.** **Step 2: Validar** (build, suíte, typecheck, lint, paridade i18n). **Step 3: Commit** — `feat: acompanhamento de transmissão com polling, pausa e cancelamento`

---

### Task 7: Verificação de conjunto

- [ ] **Step 1:** `npx vitest run && npm run typecheck && npm run lint && npm run build` — tudo limpo (2 falhas pré-existentes conhecidas na suíte).
- [ ] **Step 2:** Conferir por diff que `use-broadcast-sending.ts` e `POST /api/whatsapp/broadcast` (singular) não mudaram de comportamento (constraint global).
- [ ] **Step 3:** Roteiro manual documentado no relatório (execução depende de provedor conectado — mesmo gate dos E2E das fases anteriores): criar transmissão de texto com placeholder para 3 contatos de teste via conta WAHA/Uazapi, agendar para +2 min, acompanhar polling, pausar/retomar, cancelar uma segunda; conferir notificação de conclusão no sino e contadores.
- [ ] **Step 4:** Commit final — `feat: fase 2 de transmissões completa`

## Fora deste plano

- API pública v1 com texto livre; unificação do Meta imediato no cron; spintax/variação automática; reenvio em massa de falhas (spec, seção "Fora de escopo").
