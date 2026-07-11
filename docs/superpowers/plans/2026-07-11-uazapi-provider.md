# Plano — Provedor Uazapi (v1): QR, chat ponta a ponta e reações

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conta do CRM conecta um número de WhatsApp via QR Code pela Uazapi (serviço na nuvem, instância criada automaticamente) e conversa ponta a ponta pelo inbox, com reações; Meta e WAHA intocados.

**Architecture:** Reusa integralmente a fundação da fase 1 WAHA: camada de provedores (`src/lib/whatsapp/providers/`), pipeline inbound compartilhado (`src/lib/whatsapp/inbound.ts`), gating por capacidades. Novidades: migração 038 generaliza colunas (`provider_session`/`provider_phone`), cliente `uazapi-api.ts` (admin token cria instância; token por instância criptografado em `access_token`), webhook com segredo na URL (Uazapi não assina), reações despachadas por capacidade. Spec: `docs/superpowers/specs/2026-07-11-uazapi-provider-design.md`.

**Tech Stack:** Next.js 16 (App Router), Supabase, TypeScript, vitest, Uazapi (uazapiGO v2.1.1 — spec OpenAPI em https://docs.uazapi.com/openapi-bundled.json).

## Global Constraints

- **Meta e WAHA não mudam de comportamento.** O único toque neles é o rename mecânico `waha_session→provider_session` / `waha_phone→provider_phone` (Task 1) e a guarda de reação virar capability-based (Task 3). Critério permanente: `npx vitest run` sem falhas novas (2 pré-existentes conhecidas: date-utils/mondayIndex), `npm run typecheck`, `npm run lint` limpos em toda task.
- **Next.js 16 tem breaking changes** — consulte `node_modules/next/dist/docs/` antes de mexer em rotas (instrução do AGENTS.md).
- **Segredos server-side apenas:** `UAZAPI_ADMIN_TOKEN`, `UAZAPI_WEBHOOK_SECRET` e o token de instância nunca chegam ao navegador. O token de instância é armazenado **criptografado** via `encrypt()` de `src/lib/whatsapp/encryption.ts` na coluna `access_token`.
- **i18n em paridade:** strings novas em `messages/en.json` E `messages/pt.json` (app roda em pt).
- **Sem as 3 envs (`UAZAPI_URL`, `UAZAPI_ADMIN_TOKEN`, `UAZAPI_WEBHOOK_SECRET`) ⇒ opção Uazapi oculta e rotas retornam 501**; comportamento idêntico ao atual.
- **Migrações:** aplicar no Supabase remoto via Management API (token pedido ao usuário na hora; NUNCA commitá-lo) e registrar em `supabase_migrations.schema_migrations`.
- Endpoints Uazapi conforme o spec OpenAPI (Task 2 Step 0 confere ao vivo). Servidor de teste E2E: `https://free.uazapi.com` (instâncias expiram em 1h).
- Commits no branch `personalizacao-display4`, mensagens em português, rodapé `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Migração 038 — generalização das colunas + rename no código

**Files:**
- Create: `supabase/migrations/038_provider_generalization.sql`
- Modify (rename mecânico `waha_session`→`provider_session`, `waha_phone`→`provider_phone` em todas as ocorrências): `src/types/index.ts`, `src/app/api/whatsapp/webhook/waha/route.ts`, `src/app/api/whatsapp/config/route.ts`, `src/app/api/whatsapp/waha/session/route.ts`, `src/lib/whatsapp/providers/resolve.ts`, `src/lib/whatsapp/providers/resolve.test.ts`

**Interfaces:**
- Produces: colunas `whatsapp_config.provider_session` (única, parcial) e `provider_phone`; CHECK `provider IN ('meta','waha','uazapi')`; tipo `WhatsAppConfig` com `provider: 'meta'|'waha'|'uazapi'`, `provider_session?: string|null`, `provider_phone?: string|null`; `resolveProvider` recebendo `Pick<..., 'provider'|'phone_number_id'|'provider_session'>`.

- [ ] **Step 1: Escrever a migração**

```sql
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

-- Aceita o terceiro provedor.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_provider_check;
ALTER TABLE whatsapp_config
  ADD CONSTRAINT whatsapp_config_provider_check
  CHECK (provider IN ('meta', 'waha', 'uazapi'));
```

Atenção: confira no `037_whatsapp_provider.sql` o nome real do CHECK de provider (CHECK inline de coluna vira `whatsapp_config_provider_check` por convenção do Postgres — validar com `\d` mental ou pg_constraint; se o nome divergir, ajustar o DROP).

- [ ] **Step 2: Rename no código (mecânico)**

Nos 6 arquivos listados: substituir todas as ocorrências de `waha_session` por `provider_session` e `waha_phone` por `provider_phone` (identificadores de coluna em selects/upserts/tipos/Pick). Em `src/types/index.ts`, além do rename, ampliar: `provider: 'meta' | 'waha' | 'uazapi';`. NÃO renomear nada que seja conceito WAHA legítimo (`wahaSessionName`, `waha_status`, rotas `/waha/`, textos) — só as referências às DUAS colunas.

- [ ] **Step 3: Validar**

Run: `grep -rn "waha_session\|waha_phone" src/ | grep -v node_modules` → vazio; `npx vitest run` (sem falhas novas); `npm run typecheck`; `npm run lint`.

- [ ] **Step 4: Aplicar no Supabase remoto** (Management API, token do usuário na hora) e registrar `('038','038_provider_generalization')` em `supabase_migrations.schema_migrations`. Verificação: `SELECT provider_session FROM whatsapp_config LIMIT 1;` roda sem erro.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/038_provider_generalization.sql src/types/index.ts src/app/api/whatsapp src/lib/whatsapp/providers
git commit -m "feat: migração 038 — generaliza colunas de provedor e aceita uazapi"
```

---

### Task 2: Cliente HTTP da Uazapi (`uazapi-api.ts`)

**Files:**
- Create: `src/lib/whatsapp/uazapi-api.ts`
- Test: `src/lib/whatsapp/uazapi-api.test.ts`
- Modify: `.env.local.example` (bloco Uazapi)

**Interfaces:**
- Produces (consumido pelas Tasks 3, 4, 5):

```typescript
uazapiEnabled(): boolean            // as 3 envs presentes
uazapiInstanceName(accountId: string): string   // `wacrm_${accountId}`
createInstance(args: { name: string }): Promise<{ token: string }>          // admintoken
connectInstance(args: { token: string }): Promise<void>                      // POST /instance/connect body {}
getInstanceStatus(args: { token: string }): Promise<UazapiInstanceStatus>
disconnectInstance(args: { token: string }): Promise<void>
deleteInstance(args: { token: string }): Promise<void>                       // tolera 401/404 (instância já sumiu)
setInstanceWebhook(args: { token: string; url: string }): Promise<void>
uazapiSendText(args: { token: string; number: string; text: string; replyId?: string }): Promise<{ messageId: string }>
uazapiSendMedia(args: { token: string; number: string; kind: 'image'|'video'|'document'|'audio'; url: string; caption?: string; docName?: string }): Promise<{ messageId: string }>
uazapiSendReaction(args: { token: string; number: string; messageId: string; emoji: string }): Promise<void>
downloadUazapiMedia(args: { url: string }): Promise<Response>                // valida host UAZAPI_URL
interface UazapiInstanceStatus { status: 'disconnected'|'connecting'|'connected'|'hibernated'; qrcode: string | null; phone: string | null; loggedIn: boolean }
```

- [ ] **Step 0: Conferir o spec OpenAPI ao vivo**

`curl -s https://docs.uazapi.com/openapi-bundled.json` e confirmar: `POST /instance/create` (header `admintoken`, body `{name}`, resposta `{token}`), `POST /instance/connect` (header `token`), `GET /instance/status` (campos `instance.qrcode` base64, `status.loggedIn`, `status.jid.user`), `POST /instance/disconnect`, `DELETE /instance`, `POST /webhook` (`{url, events, excludeMessages}`), `POST /send/text` (`{number, text, replyid?}` → resposta com `messageid`), `POST /send/media` (`{number, type, file, text?, docName?}`), `POST /message/react` (`{number, text, id}`). Ajustar literais se divergirem.

- [ ] **Step 1: Testes que falham** (mock de fetch, padrão do waha-api.test.ts — beforeEach com stubEnv das 3 envs UAZAPI_*)

```typescript
// src/lib/whatsapp/uazapi-api.test.ts — casos mínimos:
// 1. uazapiEnabled(): true com as 3 envs; false faltando UAZAPI_WEBHOOK_SECRET
// 2. createInstance: POST {UAZAPI_URL}/instance/create com header admintoken=UAZAPI_ADMIN_TOKEN,
//    body {name}; retorna token da resposta {token: 'uuid'}
// 3. uazapiSendText: POST /send/text com header token=<token da instância>,
//    body {number, text}; extrai messageid da resposta {messageid: '3EB0...'};
//    erro legível em non-2xx (regex /Uazapi .*4\d\d/)
// 4. uazapiSendMedia: mapeia kind audio→type 'ptt', document→'document' com docName,
//    caption vai no campo text
// 5. getInstanceStatus: normaliza {instance:{status,qrcode}, status:{loggedIn, jid:{user}}}
//    para {status, qrcode, phone, loggedIn}; qrcode ausente → null
// 6. downloadUazapiMedia: recusa URL fora de UAZAPI_URL (mesma regra do waha-api)
```

Escrever os testes completos seguindo byte a byte o estilo de `src/lib/whatsapp/waha-api.test.ts` (vi.stubEnv/stubGlobal, Response mock, import dinâmico).

- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run src/lib/whatsapp/uazapi-api.test.ts` → módulo inexistente.

- [ ] **Step 3: Implementar o cliente** — espelhar a estrutura de `waha-api.ts` (base() a partir de `UAZAPI_URL`, `uazapiFetch(path, {token | admin: true})` que injeta o header certo — `token` ou `admintoken` —, lança `Error('Uazapi ${path} falhou: ${status} ${corpo.slice(0,300)}')` em non-2xx). Particularidades:
  - `createInstance` usa `admin: true`.
  - `deleteInstance`/`disconnectInstance` toleram 401/404 (instância expirada/apagada — demo server apaga em 1h) sem lançar.
  - `setInstanceWebhook` envia `{ url, events: ['messages','messages_update','connection'], excludeMessages: ['wasSentByApi'] }`.
  - `uazapiSendMedia`: `{ number, type: MAP[kind], file: url, ...(caption && {text: caption}), ...(docName && {docName}) }` com `MAP = {image:'image', video:'video', document:'document', audio:'ptt'}`.
  - `getInstanceStatus`: telefone = `data.status?.jid?.user ?? null`; `qrcode` = `data.instance?.qrcode || null`.
  - `downloadUazapiMedia`: mesma validação de prefixo do `downloadWahaMedia`.

- [ ] **Step 4: Rodar testes** → PASS. `npm run typecheck` limpo.

- [ ] **Step 5: `.env.local.example`** — bloco novo no OPTIONAL:

```bash
# ------------------------------------------------------------------
# Uazapi — provedor não oficial de WhatsApp via QR Code (opcional)
# ------------------------------------------------------------------
# Serviço hospedado (https://uazapi.com). Assine um plano para ganhar
# seu servidor + admin token. As TRÊS variáveis são obrigatórias para
# a opção Uazapi aparecer nas Configurações.
# Para testes: https://free.uazapi.com (instâncias expiram em 1 hora).
# UAZAPI_URL=https://seuservidor.uazapi.com
# UAZAPI_ADMIN_TOKEN=seu-admin-token
# Segredo embutido na URL do webhook (a Uazapi não assina webhooks).
# Gere com: openssl rand -hex 32
# UAZAPI_WEBHOOK_SECRET=gere-um-segredo-longo
```

- [ ] **Step 6: Commit** — `feat: cliente HTTP da Uazapi (instâncias, QR, envio, reação, mídia)`

---

### Task 3: Provedor uazapi + reações por capacidade

**Files:**
- Create: `src/lib/whatsapp/providers/uazapi.ts`
- Modify: `src/lib/whatsapp/providers/types.ts` (CAPABILITIES.uazapi), `src/lib/whatsapp/providers/resolve.ts` (ramo uazapi), `src/lib/whatsapp/providers/resolve.test.ts` (casos novos)
- Modify: `src/app/api/whatsapp/react/route.ts` (guarda por capacidade + dispatch uazapi)

**Interfaces:**
- Consumes: `uazapiSendText/uazapiSendMedia/uazapiSendReaction` (Task 2).
- Produces: `resolveProvider(config, accessToken)` retorna provedor uazapi quando `config.provider==='uazapi'` (exige `provider_session` e `accessToken` — aqui o token é o da instância, descriptografado pelo chamador como no ramo Meta); `CAPABILITIES.uazapi = { supportsTemplates: false, has24hWindow: false, supportsInteractive: false, supportsReactions: true }`.

- [ ] **Step 1: Testes que falham** em `resolve.test.ts`: (a) uazapi resolve com capacidades certas (`supportsReactions: true`, resto false); (b) uazapi sem `provider_session` lança; (c) uazapi sem accessToken lança (mensagens claras, padrão dos ramos existentes).

- [ ] **Step 2: Implementar** `providers/uazapi.ts` (espelho de `waha.ts`: `uazapiProvider(instanceToken: string)` → sendText/sendMedia mapeando `to→number`, `mediaUrl→url`, `replyToExternalId→replyId`, `filename→docName`) + entrada em CAPABILITIES + ramo em `resolve.ts`:

```typescript
  if (config.provider === 'uazapi') {
    if (!config.provider_session) throw new Error('Config Uazapi sem instância vinculada — reconecte pelo QR Code.')
    if (!accessToken) throw new Error('Config Uazapi sem token de instância descriptografado.')
    return uazapiProvider(accessToken)
  }
```

IMPORTANTE — call sites de envio (send-message.ts, automations/meta-send.ts, flows/meta-send.ts) fazem hoje `accessToken = config.provider === 'waha' ? null : decrypt(config.access_token)`. Para uazapi o decrypt é NECESSÁRIO (token real criptografado) — a expressão já cobre isso por cair no else. Verificar os 3 call sites e confirmar que nenhum tem lógica extra keyed em 'waha' que quebre com uazapi; registrar a verificação no relatório.

- [ ] **Step 3: Reações** em `react/route.ts` — a guarda atual (linha ~129) é `if (config.provider === 'waha')` antes do decrypt. Trocar por lógica de capacidade + dispatch:

```typescript
    const caps = CAPABILITIES[config.provider as 'meta'|'waha'|'uazapi'] ?? CAPABILITIES.meta;
    if (!caps.supportsReactions) {
      return NextResponse.json(
        { error: 'unsupported_by_provider',
          message: 'Reações não são suportadas pelo provedor conectado.' },
        { status: 422 },
      );
    }
    const accessToken = decrypt(config.access_token);
    if (config.provider === 'uazapi') {
      await uazapiSendReaction({
        token: accessToken,
        number: /* telefone do contato, mesmo valor que o ramo Meta usa como 'to' */,
        messageId: /* wamid/messageid alvo, mesmo valor do ramo Meta */,
        emoji, // string vazia remove, igual à Meta
      });
      return /* mesma resposta de sucesso do ramo Meta */;
    }
    // ramo Meta existente segue inalterado (sendReactionMessage)
```

Estudar a rota inteira antes: reusar as variáveis reais (nomes do contato/message id) e manter o formato de resposta idêntico ao ramo Meta. O select da rota precisa incluir `provider_session` se ainda não inclui.

- [ ] **Step 4: Validar** — `npx vitest run src/lib/whatsapp/providers/resolve.test.ts` PASS; suíte completa sem falhas novas; typecheck; lint. Confirmar por leitura que o gating de UI da reação (message-thread, hook useProviderCapabilities) já reflete `supportsReactions` sem mudança (foi feito por capacidade na fase WAHA).

- [ ] **Step 5: Commit** — `feat: provedor uazapi na camada de provedores + reações por capacidade`

---

### Task 4: Webhook da Uazapi + proxy de mídia

**Files:**
- Create: `src/lib/whatsapp/uazapi-webhook.ts` (helpers testáveis)
- Create: `src/app/api/whatsapp/webhook/uazapi/route.ts`
- Create: `src/app/api/whatsapp/uazapi/media/route.ts`
- Test: `src/lib/whatsapp/uazapi-webhook.test.ts`

**Interfaces:**
- Consumes: `persistInboundMessage`, `applyStatusByExternalId` (pipeline compartilhado); `downloadUazapiMedia` (Task 2).
- Produces: `verifyUrlSecret(provided: string | null): boolean` (timing-safe vs `UAZAPI_WEBHOOK_SECRET`); `normalizeUazapiMessage(data, mediaProxyPath): NormalizedInboundMessage | null`; `mapUazapiStatus(status: string): 'sent'|'delivered'|'read'|'failed'|null`.

- [ ] **Step 1: Testes que falham** (`uazapi-webhook.test.ts`):
  - `verifyUrlSecret`: aceita o segredo exato, rejeita errado/null/vazio; comparação em tempo constante (crypto.timingSafeEqual sobre buffers utf8 de mesmo comprimento — comprimento diferente → false direto).
  - `mapUazapiStatus`: `'Sent'→'sent'`, `'Delivered'→'delivered'`, `'Read'→'read'`, `'Failed'→'failed'`, `'Queued'/'Canceled'/desconhecido→null`.
  - `normalizeUazapiMessage` texto: payload `{messageid, chatid: '5511999999999@s.whatsapp.net', sender, fromMe: false, text: 'olá', messageTimestamp: 1767998400000, senderName: 'Fulano'}` → NormalizedInboundMessage com externalId=messageid, fromPhone='5511999999999', contentType 'text', timestamp de ms. (ATENÇÃO: o schema Message real da Uazapi pode nomear campos diferente — `content`, `text`, `caption`; o Step 0 da Task 2 já baixou o spec: extrair o schema `Message` de lá e ancorar o teste nos nomes REAIS. Se o spec for ambíguo, implementar tolerante a ambos e registrar para confirmação no E2E.)
  - `normalizeUazapiMessage` grupo (`@g.us`) → null; mídia → mediaUrl vira `${mediaProxyPath}?src=...` reusando o padrão buildMediaProxyUrl (copiar o helper ou generalizar o existente de waha-webhook.ts — decidir pelo menor acoplamento e justificar).

- [ ] **Step 2: Implementar helpers + rotas.** Rota do webhook: `POST /api/whatsapp/webhook/uazapi` — 501 sem `uazapiEnabled()`; lê `?s=` da query e valida com `verifyUrlSecret` (401); parse JSON `{event, instance, data}`; resolve config por `.eq('provider_session', instance).eq('provider', 'uazapi')`; desconhecida → descarta com warn; processamento em `after()`:
  - `messages` → normaliza → `persistInboundMessage(normalized, config.account_id, config.user_id)`.
  - `messages_update` → `applyStatusByExternalId(data.messageid ?? data.id, mapUazapiStatus(data.status), timestamp se disponível)`.
  - `connection` → status `disconnected|hibernated` → config `disconnected` + INSERT notification `whatsapp_disconnected` (copiar o bloco do webhook WAHA); `connected` → config `connected`.
  Proxy de mídia: cópia adaptada de `src/app/api/whatsapp/waha/media/route.ts` (auth de usuário + checagem de `messages.media_url` via RLS + `downloadUazapiMedia`) — mesmíssimo padrão pós-fix de isolamento.

- [ ] **Step 3: Validar** — testes novos PASS, suíte completa, typecheck, lint.

- [ ] **Step 4: Commit** — `feat: webhook uazapi (segredo na URL, mensagens, status, conexão) + proxy de mídia`

---

### Task 5: Rotas de instância (conectar/status/desconectar)

**Files:**
- Create: `src/app/api/whatsapp/uazapi/instance/route.ts` (POST cria+conecta; GET status+QR; DELETE remove)
- Modify: `src/app/api/whatsapp/config/route.ts` (ramo uazapi no GET health + DELETE)

**Interfaces:**
- Consumes: Task 2 inteira; `getCurrentAccount` de `@/lib/auth/account` (padrão das rotas WAHA); `encrypt`/`decrypt`; `supabaseAdmin`.
- Produces (para a UI, Task 6):
  - `POST /api/whatsapp/uazapi/instance` → `{ ok: true }` — cria instância na Uazapi (nome `wacrm_<account_id>`), grava config (`provider='uazapi'`, `provider_session`=id da instância retornado, `access_token`=encrypt(token da instância), `status='disconnected'`, `user_id`, `account_id`, `phone_number_id: null`), registra webhook (`${NEXT_PUBLIC_SITE_URL}/api/whatsapp/webhook/uazapi?s=${UAZAPI_WEBHOOK_SECRET}`) e chama `connectInstance`. 409 se existir config de OUTRO provedor; se já existe config uazapi (reconexão), reusa o token salvo e só re-chama `connectInstance` — MAS se `getInstanceStatus` com o token salvo der 401/404 (instância morta — caso demo 1h), deleta a config-fantasma via `deleteInstance` best-effort e cria instância nova do zero.
  - `GET /api/whatsapp/uazapi/instance` → `{ status, qrcode, phone }` (qrcode = string base64 pronta para `<img src>` — se a Uazapi devolver sem prefixo `data:image/png;base64,`, prefixar aqui). Quando `status==='connected' && loggedIn && phone`: atualiza config (`provider_phone`, `status='connected'`, `connected_at`).
  - `DELETE /api/whatsapp/uazapi/instance` → desconecta + deleta instância na Uazapi (best-effort) + apaga a linha de config (só a de provider uazapi).
- No `config/route.ts`: GET ganha ramo `provider === 'uazapi'` (antes do decrypt Meta): `getInstanceStatus` com token descriptografado → `{connected: status==='connected' && loggedIn, provider: 'uazapi', capabilities: CAPABILITIES.uazapi, uazapi_available: uazapiEnabled(), ...}` com reasons `uazapi_session_down`/`uazapi_server_unreachable` (mesmo padrão WAHA); decrypt falhou → reusar o retorno `token_corrupted` existente com `provider: 'uazapi'`. TODOS os returns do GET ganham também `uazapi_available: uazapiEnabled()` (além do `waha_available` existente). DELETE ganha o ramo uazapi (disconnect+delete best-effort antes da limpeza).

- [ ] **Step 1: Implementar as rotas** (espelho estrutural de `waha/session/route.ts`, mesmo `requireAccount`-pattern via `getCurrentAccount`).
- [ ] **Step 2: Validar** — typecheck, lint, suíte completa.
- [ ] **Step 3: Commit** — `feat: rotas de instância uazapi + config ciente do terceiro provedor`

---

### Task 6: UI — terceiro cartão + painel QR da Uazapi

**Files:**
- Create: `src/components/settings/whatsapp-uazapi-config.tsx`
- Modify: `src/components/settings/whatsapp-config.tsx` (terceiro cartão no seletor)
- Modify: `messages/en.json`, `messages/pt.json` (bloco `Settings.uazapi`)

**Interfaces:**
- Consumes: rotas da Task 5.

- [ ] **Step 1: Strings i18n** — bloco `"uazapi"` dentro de `"Settings"`, nas duas línguas (espelhar as chaves do bloco `waha`: providerUazapi/hint, connect, connecting, scanTitle, scanHint, qrExpiredHint, connectedAs, disconnect, disconnectConfirm, disconnectFailed, sessionDown, serverUnreachable, switchBlocked, banWarning — textos adaptados: "Uazapi — QR Code", "Serviço na nuvem; escaneie com o celular", aviso de banimento igual ao da WAHA). Check de paridade i18n ao final (mesmo node -e das tasks WAHA).

- [ ] **Step 2: Componente** `whatsapp-uazapi-config.tsx` — cópia adaptada de `whatsapp-waha-config.tsx` (estados IDLE/connecting/connected, polling 3s enquanto conecta, disconnect com confirm + tratamento de falha com toast). Diferenças: o QR vem no JSON do `GET /api/whatsapp/uazapi/instance` (campo `qrcode`, data URL) → `<img src={qrcode}>` re-renderizado a cada poll (a Uazapi renova o QR pelo próprio status — não precisa do timer de 20s da WAHA, o polling de 3s já traz o QR novo); estados da Uazapi: `disconnected|connecting|connected|hibernated`.

- [ ] **Step 3: Seletor** em `whatsapp-config.tsx` — o estado `selectedProvider` passa a `'meta'|'waha'|'uazapi'`; terceiro cartão renderizado quando `uazapi_available` (o GET do config já retorna); cartões dos provedores não-salvos ficam desabilitados quando há config salva de outro (regra switchBlocked existente, agora com 3).

- [ ] **Step 4: Validar** — typecheck, lint, paridade i18n, `npm run build` (ou dev compila /settings), suíte completa.

- [ ] **Step 5: Commit** — `feat: cartão e painel QR da Uazapi nas Configurações`

---

### Task 7: E2E contra o servidor demo + encerramento

- [ ] **Step 1: Configurar env de teste** — no `.env.local`: `UAZAPI_URL=https://free.uazapi.com`, `UAZAPI_ADMIN_TOKEN=<token demo — conferir na doc/site como obter o admin do free; se o free não expuser admintoken público, criar a instância manualmente via painel/endpoint documentado e adaptar o teste>`, `UAZAPI_WEBHOOK_SECRET=<openssl rand -hex 32>`, `NEXT_PUBLIC_SITE_URL` alcançável pela Uazapi (ATENÇÃO: a Uazapi é nuvem — para o webhook chegar no CRM local é preciso um túnel tipo `cloudflared tunnel` ou `ngrok`; sem túnel, validar recebimento apenas em deploy — registrar a limitação).
- [ ] **Step 2: Roteiro** — conectar via QR nas Configurações; receber texto e foto; responder com texto e imagem; reagir a uma mensagem do cliente (e conferir no celular); eco fromMe digitado no celular (sem duplicata); status entregue/lida progredindo; esperar a instância demo expirar (1h) → notificação de queda no sino; reconectar do zero (fluxo de instância órfã). Regressão: suíte completa + smoke do caminho Meta e WAHA (telas abrem, health responde).
- [ ] **Step 3: Commit final** — ajustes achados no E2E + `feat: provedor Uazapi v1 completo`.

---

## Fora deste plano

- Botões/listas nativos da Uazapi → fase 3 do roadmap (interativos nos fluxos).
- Transmissões → fase 2 (WAHA + Uazapi juntos).
- Paircode, grupos, canais, campanhas `/sender/*`, SSE, webhook global.
