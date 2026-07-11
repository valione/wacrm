# Plano 1 — Provedor WAHA: fundação + chat ponta a ponta

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conta do CRM conecta um número de WhatsApp via QR Code (WAHA) e conversa ponta a ponta pelo inbox (enviar/receber texto e mídia), sem quebrar nada do caminho Meta.

**Architecture:** Camada de adapter em `src/lib/whatsapp/providers/` (interface + capacidades; Meta embrulha o `meta-api.ts` intocado, WAHA ganha cliente HTTP novo). Os 3 call sites de envio despacham pela interface. Inbound: helpers de persistência extraídos do webhook Meta para módulo compartilhado; rota nova `/api/whatsapp/webhook/waha` valida HMAC e alimenta o mesmo pipeline. Spec: `docs/superpowers/specs/2026-07-10-waha-provider-design.md`.

**Tech Stack:** Next.js 16 (App Router), Supabase (Postgres + RLS), TypeScript, vitest, WAHA (https://waha.devlike.pro/swagger/).

## Global Constraints

- **Meta intocada:** `src/lib/whatsapp/meta-api.ts` não muda. Qualquer alteração em arquivos do caminho Meta deve preservar comportamento (verificar com a suíte vitest existente: `npm test`).
- **Next.js 16 tem breaking changes** — antes de mexer em rotas/proxy, leia o guia relevante em `node_modules/next/dist/docs/` (instrução do AGENTS.md do repo).
- **Segredos nunca no navegador:** `WAHA_API_KEY` e `WAHA_WEBHOOK_SECRET` só em código server-side (rotas de API / libs importadas por elas).
- **i18n em paridade:** toda string nova de UI entra em `messages/en.json` E `messages/pt.json` (o app roda com `NEXT_PUBLIC_APP_LOCALE=pt`).
- **Sem `WAHA_URL` no env ⇒ comportamento idêntico ao atual** (opção WAHA oculta, rotas WAHA retornam 501).
- **Migrações:** aplicar no Supabase remoto via API de management (mesmo método das 001–036; ver Task 1 Step 4) e registrar em `supabase_migrations.schema_migrations`.
- Endpoints WAHA citados devem ser conferidos contra o swagger (https://waha.devlike.pro/swagger/) na Task 2 antes de codar — nomes de campos podem variar entre versões do WAHA.
- Commits no branch `personalizacao-display4`, mensagens em português, rodapé `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Migração 037 — colunas de provedor

**Files:**
- Create: `supabase/migrations/037_whatsapp_provider.sql`
- Modify: `src/types/index.ts:269-289` (interface `WhatsAppConfig`)

**Interfaces:**
- Produces: colunas `whatsapp_config.provider|waha_session|waha_phone`; tipo `WhatsAppConfig` com `provider: 'meta' | 'waha'`; CHECK de notificações aceita tipo `whatsapp_disconnected`.

- [ ] **Step 1: Escrever a migração**

```sql
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
```

- [ ] **Step 2: Atualizar o tipo `WhatsAppConfig`**

Em `src/types/index.ts` (interface na linha 269), adicionar após `user_id: string;`:

```typescript
  /** Provedor da conexão. 'meta' = Cloud API oficial; 'waha' = sessão WAHA via QR. */
  provider: 'meta' | 'waha';
  /** Nome da sessão no servidor WAHA (`wacrm_<account_id>`). Null para Meta. */
  waha_session?: string | null;
  /** Número vinculado após o QR (E.164 sem '+'). Null para Meta. */
  waha_phone?: string | null;
```

E mudar `phone_number_id: string;` para `phone_number_id: string | null;`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: os erros novos (se houver) apontam call sites que assumem `phone_number_id` não-nulo — anote-os; serão tratados na Task 4 (por ora, se o typecheck quebrar em `send-message.ts`/`meta-send.ts`, adicione `!` no uso, pois esses caminhos só executam quando `provider==='meta'`).

- [ ] **Step 4: Aplicar no Supabase remoto e registrar**

O projeto usa migrações aplicadas via Supabase Management API (`POST /v1/projects/hhnmzwuuqyllydfdpmxs/database/query`, token de acesso pedido ao usuário na hora — NUNCA commitá-lo). Executar o SQL da migração e depois:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('037', '037_whatsapp_provider') ON CONFLICT (version) DO NOTHING;
```

Verificação: `SELECT provider, waha_session FROM whatsapp_config LIMIT 1;` roda sem erro.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/037_whatsapp_provider.sql src/types/index.ts
git commit -m "feat: migração 037 — colunas de provedor WAHA em whatsapp_config"
```

---

### Task 2: Cliente HTTP da WAHA (`waha-api.ts`)

**Files:**
- Create: `src/lib/whatsapp/waha-api.ts`
- Test: `src/lib/whatsapp/waha-api.test.ts`

**Interfaces:**
- Produces (usado pelas Tasks 3, 8, 9):

```typescript
wahaEnabled(): boolean                      // WAHA_URL && WAHA_API_KEY presentes
wahaSessionName(accountId: string): string  // `wacrm_${accountId}`
toChatId(phone: string): string             // '5511999999999' -> '5511999999999@c.us'
fromChatId(chatId: string): string          // inverso (corta o sufixo @c.us/@s.whatsapp.net)
createSession(args: { session: string; webhookUrl: string }): Promise<void>
getSession(args: { session: string }): Promise<WahaSessionInfo>
getQrPng(args: { session: string }): Promise<ArrayBuffer>
logoutAndDelete(args: { session: string }): Promise<void>
wahaSendText(args: { session: string; chatId: string; text: string; replyTo?: string }): Promise<{ messageId: string }>
wahaSendMedia(args: { session: string; chatId: string; kind: 'image'|'video'|'document'|'audio'; url: string; caption?: string; filename?: string }): Promise<{ messageId: string }>
downloadWahaMedia(args: { url: string }): Promise<Response>   // fetch autenticado, valida que url começa com WAHA_URL
interface WahaSessionInfo { status: 'STOPPED'|'STARTING'|'SCAN_QR_CODE'|'WORKING'|'FAILED'; me?: { id: string; pushName?: string } }
```

- [ ] **Step 0: Conferir o swagger**

Abrir https://waha.devlike.pro/swagger/ e confirmar, para a versão corrente: paths de sessão (`POST /api/sessions`, `GET /api/sessions/{name}`, `POST /api/sessions/{name}/logout`, `DELETE /api/sessions/{name}`), QR (`GET /api/{session}/auth/qr`, `Accept: image/png`), envio (`POST /api/sendText`, `/api/sendImage`, `/api/sendFile`, `/api/sendVoice`, `/api/sendVideo`) e o formato do corpo de webhook. Ajustar os literais abaixo se divergirem.

- [ ] **Step 1: Escrever os testes que falham**

```typescript
// src/lib/whatsapp/waha-api.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('waha-api', () => {
  beforeEach(() => {
    vi.stubEnv('WAHA_URL', 'http://waha.local:3001')
    vi.stubEnv('WAHA_API_KEY', 'test-key')
    vi.stubGlobal('fetch', vi.fn())
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('toChatId/fromChatId convertem telefone <-> chatId', async () => {
    const { toChatId, fromChatId } = await import('./waha-api')
    expect(toChatId('5511999999999')).toBe('5511999999999@c.us')
    expect(fromChatId('5511999999999@c.us')).toBe('5511999999999')
    expect(fromChatId('5511999999999@s.whatsapp.net')).toBe('5511999999999')
  })

  it('wahaSendText faz POST /api/sendText com X-Api-Key e retorna o id', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response(JSON.stringify({ id: 'true_5511@c.us_ABC' }), { status: 201 }))
    const { wahaSendText } = await import('./waha-api')
    const r = await wahaSendText({ session: 's1', chatId: '5511@c.us', text: 'oi' })
    expect(r.messageId).toBe('true_5511@c.us_ABC')
    const [url, init] = mock.mock.calls[0]
    expect(url).toBe('http://waha.local:3001/api/sendText')
    expect((init.headers as Record<string, string>)['X-Api-Key']).toBe('test-key')
    expect(JSON.parse(init.body as string)).toMatchObject({ session: 's1', chatId: '5511@c.us', text: 'oi' })
  })

  it('wahaSendText lança erro legível em non-2xx', async () => {
    const mock = fetch as ReturnType<typeof vi.fn>
    mock.mockResolvedValue(new Response('{"message":"session not working"}', { status: 422 }))
    const { wahaSendText } = await import('./waha-api')
    await expect(wahaSendText({ session: 's1', chatId: 'x@c.us', text: 'oi' }))
      .rejects.toThrow(/WAHA .*422/)
  })

  it('downloadWahaMedia recusa URL fora do WAHA_URL', async () => {
    const { downloadWahaMedia } = await import('./waha-api')
    await expect(downloadWahaMedia({ url: 'http://evil.example/x.jpg' }))
      .rejects.toThrow(/fora do servidor WAHA/)
  })

  it('wahaEnabled reflete presença das envs', async () => {
    const { wahaEnabled } = await import('./waha-api')
    expect(wahaEnabled()).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp/waha-api.test.ts`
Expected: FAIL — `Cannot find module './waha-api'`.

- [ ] **Step 3: Implementar o cliente**

```typescript
// src/lib/whatsapp/waha-api.ts
// Cliente HTTP do servidor WAHA (https://waha.devlike.pro/swagger/).
// Espelha o papel do meta-api.ts para o provedor WAHA: cada função faz
// um fetch isolado, lança em non-2xx e retorna dados mínimos.
// Server-side apenas — usa WAHA_API_KEY.

function wahaBase(): string {
  const url = process.env.WAHA_URL
  if (!url) throw new Error('WAHA_URL não configurada')
  return url.replace(/\/$/, '')
}

export function wahaEnabled(): boolean {
  return Boolean(process.env.WAHA_URL && process.env.WAHA_API_KEY)
}

export function wahaSessionName(accountId: string): string {
  return `wacrm_${accountId}`
}

export function toChatId(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`
}

export function fromChatId(chatId: string): string {
  return chatId.replace(/@.*$/, '')
}

async function wahaFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${wahaBase()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.WAHA_API_KEY ?? '',
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`WAHA ${path} falhou: ${response.status} ${body.slice(0, 300)}`)
  }
  return response
}

export interface WahaSessionInfo {
  status: 'STOPPED' | 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'FAILED'
  me?: { id: string; pushName?: string }
}

/** Cria (ou recria) e inicia a sessão, já apontando o webhook de volta pro CRM. */
export async function createSession(args: { session: string; webhookUrl: string }): Promise<void> {
  await wahaFetch('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({
      name: args.session,
      start: true,
      config: {
        webhooks: [
          {
            url: args.webhookUrl,
            events: ['message', 'message.ack', 'session.status'],
            hmac: { key: process.env.WAHA_WEBHOOK_SECRET ?? '' },
          },
        ],
      },
    }),
  })
}

export async function getSession(args: { session: string }): Promise<WahaSessionInfo> {
  const r = await wahaFetch(`/api/sessions/${encodeURIComponent(args.session)}`)
  const data = await r.json()
  return { status: data.status, me: data.me ?? undefined }
}

export async function getQrPng(args: { session: string }): Promise<ArrayBuffer> {
  const r = await wahaFetch(`/api/${encodeURIComponent(args.session)}/auth/qr`, {
    headers: { Accept: 'image/png' },
  })
  return r.arrayBuffer()
}

export async function logoutAndDelete(args: { session: string }): Promise<void> {
  // Logout desvincula o número; DELETE remove a sessão do servidor.
  // Ambos toleram 404 (sessão já removida) para o reset ser idempotente.
  const tolerate404 = async (fn: () => Promise<Response>) => {
    try { await fn() } catch (err) {
      if (!(err instanceof Error && /: 404/.test(err.message))) throw err
    }
  }
  await tolerate404(() =>
    wahaFetch(`/api/sessions/${encodeURIComponent(args.session)}/logout`, { method: 'POST' }))
  await tolerate404(() =>
    wahaFetch(`/api/sessions/${encodeURIComponent(args.session)}`, { method: 'DELETE' }))
}

export async function wahaSendText(args: {
  session: string; chatId: string; text: string; replyTo?: string
}): Promise<{ messageId: string }> {
  const r = await wahaFetch('/api/sendText', {
    method: 'POST',
    body: JSON.stringify({
      session: args.session,
      chatId: args.chatId,
      text: args.text,
      ...(args.replyTo ? { reply_to: args.replyTo } : {}),
    }),
  })
  const data = await r.json()
  // WAHA retorna o objeto da mensagem; id pode vir como string ou {id,_serialized}.
  const id = typeof data.id === 'string' ? data.id : data.id?._serialized
  if (!id) throw new Error('WAHA sendText: resposta sem id de mensagem')
  return { messageId: id }
}

const WAHA_MEDIA_PATHS = {
  image: '/api/sendImage',
  video: '/api/sendVideo',
  document: '/api/sendFile',
  audio: '/api/sendVoice',
} as const

export async function wahaSendMedia(args: {
  session: string; chatId: string
  kind: keyof typeof WAHA_MEDIA_PATHS
  url: string; caption?: string; filename?: string
}): Promise<{ messageId: string }> {
  const body: Record<string, unknown> = {
    session: args.session,
    chatId: args.chatId,
    file: { url: args.url, ...(args.filename ? { filename: args.filename } : {}) },
  }
  // Voz não aceita caption (mesma regra do caminho Meta para áudio).
  if (args.caption && args.kind !== 'audio') body.caption = args.caption
  const r = await wahaFetch(WAHA_MEDIA_PATHS[args.kind], { method: 'POST', body: JSON.stringify(body) })
  const data = await r.json()
  const id = typeof data.id === 'string' ? data.id : data.id?._serialized
  if (!id) throw new Error(`WAHA ${WAHA_MEDIA_PATHS[args.kind]}: resposta sem id`)
  return { messageId: id }
}

/** Baixa mídia hospedada no WAHA com a API key. Só aceita URLs do próprio servidor. */
export async function downloadWahaMedia(args: { url: string }): Promise<Response> {
  if (!args.url.startsWith(wahaBase() + '/')) {
    throw new Error('URL de mídia fora do servidor WAHA')
  }
  return wahaFetch(args.url.slice(wahaBase().length))
}
```

- [ ] **Step 4: Rodar os testes**

Run: `npx vitest run src/lib/whatsapp/waha-api.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Documentar as envs no `.env.local.example`**

Adicionar ao bloco OPTIONAL:

```bash
# ------------------------------------------------------------------
# WAHA — provedor não oficial de WhatsApp via QR Code (opcional)
# ------------------------------------------------------------------
# Servidor WAHA único para a instalação (docker run devlikeapro/waha).
# Sem WAHA_URL, a opção WAHA não aparece nas Configurações.
# WAHA_URL=http://localhost:3001
# WAHA_API_KEY=troque-por-uma-chave-forte
# Valida o HMAC dos webhooks que a WAHA envia ao CRM (openssl rand -hex 32).
# WAHA_WEBHOOK_SECRET=gere-um-segredo-longo
# O CRM precisa ser alcançável pelo servidor WAHA. Em dev local com WAHA
# em Docker, o webhook aponta para http://host.docker.internal:3000.
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/waha-api.ts src/lib/whatsapp/waha-api.test.ts .env.local.example
git commit -m "feat: cliente HTTP da WAHA (sessões, QR, envio, mídia)"
```

---

### Task 3: Camada de provedores (`providers/`)

**Files:**
- Create: `src/lib/whatsapp/providers/types.ts`
- Create: `src/lib/whatsapp/providers/meta.ts`
- Create: `src/lib/whatsapp/providers/waha.ts`
- Create: `src/lib/whatsapp/providers/resolve.ts`
- Test: `src/lib/whatsapp/providers/resolve.test.ts`

**Interfaces:**
- Consumes: `waha-api.ts` (Task 2), `meta-api.ts` (existente, intocado).
- Produces (usado pelas Tasks 4, 5, 6, 10):

```typescript
interface ProviderSendArgs { to: string; text?: string; kind?: 'image'|'video'|'document'|'audio';
  mediaUrl?: string; caption?: string; filename?: string; replyToExternalId?: string }
interface WhatsAppProvider {
  readonly name: 'meta' | 'waha'
  readonly capabilities: ProviderCapabilities
  sendText(args: { to: string; text: string; replyToExternalId?: string }): Promise<{ messageId: string }>
  sendMedia(args: { to: string; kind: 'image'|'video'|'document'|'audio'; mediaUrl: string;
    caption?: string; filename?: string; replyToExternalId?: string }): Promise<{ messageId: string }>
}
interface ProviderCapabilities { supportsTemplates: boolean; has24hWindow: boolean;
  supportsInteractive: boolean; supportsReactions: boolean }
resolveProvider(config: Pick<WhatsAppConfig,'provider'|'phone_number_id'|'waha_session'>,
  accessToken: string | null): WhatsAppProvider
CAPABILITIES: Record<'meta'|'waha', ProviderCapabilities>
```

Nota deliberada (YAGNI): template e interactive **não** entram na interface na fase 1 — só a Meta os tem, e os call sites continuam chamando `sendTemplateMessage`/`sendInteractive*` diretamente no ramo Meta. A interface cobre o que os dois provedores compartilham.

- [ ] **Step 1: Teste que falha**

```typescript
// src/lib/whatsapp/providers/resolve.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('resolveProvider', () => {
  beforeEach(() => {
    vi.stubEnv('WAHA_URL', 'http://waha.local:3001')
    vi.stubEnv('WAHA_API_KEY', 'k')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('meta: exige accessToken e expõe capacidades da Meta', async () => {
    const { resolveProvider } = await import('./resolve')
    const p = resolveProvider({ provider: 'meta', phone_number_id: '123', waha_session: null }, 'tok')
    expect(p.name).toBe('meta')
    expect(p.capabilities).toMatchObject({ supportsTemplates: true, has24hWindow: true })
  })

  it('waha: sem janela de 24h nem templates', async () => {
    const { resolveProvider } = await import('./resolve')
    const p = resolveProvider({ provider: 'waha', phone_number_id: null, waha_session: 'wacrm_a1' }, null)
    expect(p.name).toBe('waha')
    expect(p.capabilities).toMatchObject({ supportsTemplates: false, has24hWindow: false, supportsInteractive: false })
  })

  it('waha sem waha_session lança erro claro', async () => {
    const { resolveProvider } = await import('./resolve')
    expect(() => resolveProvider({ provider: 'waha', phone_number_id: null, waha_session: null }, null))
      .toThrow(/sessão WAHA/)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp/providers/resolve.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

```typescript
// src/lib/whatsapp/providers/types.ts
export interface ProviderCapabilities {
  supportsTemplates: boolean
  has24hWindow: boolean
  supportsInteractive: boolean
  supportsReactions: boolean
}

export const CAPABILITIES: Record<'meta' | 'waha', ProviderCapabilities> = {
  meta: { supportsTemplates: true, has24hWindow: true, supportsInteractive: true, supportsReactions: true },
  waha: { supportsTemplates: false, has24hWindow: false, supportsInteractive: false, supportsReactions: false },
}

export interface WhatsAppProvider {
  readonly name: 'meta' | 'waha'
  readonly capabilities: ProviderCapabilities
  sendText(args: { to: string; text: string; replyToExternalId?: string }): Promise<{ messageId: string }>
  sendMedia(args: {
    to: string
    kind: 'image' | 'video' | 'document' | 'audio'
    mediaUrl: string
    caption?: string
    filename?: string
    replyToExternalId?: string
  }): Promise<{ messageId: string }>
}
```

```typescript
// src/lib/whatsapp/providers/meta.ts
import { sendTextMessage, sendMediaMessage } from '@/lib/whatsapp/meta-api'
import type { WhatsAppProvider } from './types'
import { CAPABILITIES } from './types'

/** Embrulho fino: delega ao meta-api.ts existente sem mudar comportamento. */
export function metaProvider(phoneNumberId: string, accessToken: string): WhatsAppProvider {
  return {
    name: 'meta',
    capabilities: CAPABILITIES.meta,
    async sendText({ to, text, replyToExternalId }) {
      const r = await sendTextMessage({ phoneNumberId, accessToken, to, text, contextMessageId: replyToExternalId })
      return { messageId: r.messageId }
    },
    async sendMedia({ to, kind, mediaUrl, caption, filename, replyToExternalId }) {
      const r = await sendMediaMessage({
        phoneNumberId, accessToken, to, kind, link: mediaUrl,
        caption, filename, contextMessageId: replyToExternalId,
      })
      return { messageId: r.messageId }
    },
  }
}
```

```typescript
// src/lib/whatsapp/providers/waha.ts
import { wahaSendText, wahaSendMedia, toChatId } from '@/lib/whatsapp/waha-api'
import type { WhatsAppProvider } from './types'
import { CAPABILITIES } from './types'

export function wahaProvider(session: string): WhatsAppProvider {
  return {
    name: 'waha',
    capabilities: CAPABILITIES.waha,
    async sendText({ to, text, replyToExternalId }) {
      return wahaSendText({ session, chatId: toChatId(to), text, replyTo: replyToExternalId })
    },
    async sendMedia({ to, kind, mediaUrl, caption, filename }) {
      return wahaSendMedia({ session, chatId: toChatId(to), kind, url: mediaUrl, caption, filename })
    },
  }
}
```

```typescript
// src/lib/whatsapp/providers/resolve.ts
import type { WhatsAppConfig } from '@/types'
import type { WhatsAppProvider } from './types'
import { metaProvider } from './meta'
import { wahaProvider } from './waha'

export type { WhatsAppProvider, ProviderCapabilities } from './types'
export { CAPABILITIES } from './types'

/**
 * Resolve a instância de provedor a partir da linha de whatsapp_config.
 * Para Meta, o chamador já descriptografou o token (padrão atual dos
 * call sites); para WAHA o token é ignorado.
 */
export function resolveProvider(
  config: Pick<WhatsAppConfig, 'provider' | 'phone_number_id' | 'waha_session'>,
  accessToken: string | null,
): WhatsAppProvider {
  if (config.provider === 'waha') {
    if (!config.waha_session) throw new Error('Config WAHA sem sessão WAHA vinculada — reconecte pelo QR Code.')
    return wahaProvider(config.waha_session)
  }
  if (!config.phone_number_id) throw new Error('Config Meta sem phone_number_id.')
  if (!accessToken) throw new Error('Config Meta sem access token descriptografado.')
  return metaProvider(config.phone_number_id, accessToken)
}
```

- [ ] **Step 4: Rodar testes + typecheck**

Run: `npx vitest run src/lib/whatsapp/providers/resolve.test.ts && npm run typecheck`
Expected: PASS / sem erros novos.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp/providers/
git commit -m "feat: camada de provedores WhatsApp (interface + capacidades + meta/waha)"
```

---

### Task 4: Despacho por provedor no núcleo de envio do inbox

**Files:**
- Modify: `src/lib/whatsapp/send-message.ts` (imports; `attempt` em ~332-396; guarda de tipos em ~183-260)

**Interfaces:**
- Consumes: `resolveProvider` (Task 3).
- Produces: `sendMessageToConversation` funciona para contas WAHA com `messageType` `text|image|video|document|audio`; para `template|interactive` em conta WAHA lança `SendMessageError('unsupported_by_provider', …, 422)`.

- [ ] **Step 1: Adicionar import e resolver o provedor**

No topo de `src/lib/whatsapp/send-message.ts`:

```typescript
import { resolveProvider } from '@/lib/whatsapp/providers/resolve'
```

Onde o config é carregado e o token descriptografado (antes do `attempt`), o token só é descriptografado para Meta:

```typescript
const accessToken = config.provider === 'waha' ? null : decrypt(config.access_token)
const provider = resolveProvider(config, accessToken)
```

(Atenção: hoje `decrypt` roda incondicionalmente perto da linha 251-300; mover para a forma acima preservando o tratamento de erro `token_corrupted` existente no ramo Meta.)

- [ ] **Step 2: Guarda de capacidades no início do envio**

Logo após resolver o provedor, antes do `attempt`:

```typescript
if (!provider.capabilities.supportsTemplates && messageType === 'template') {
  throw new SendMessageError(
    'unsupported_by_provider',
    'Contas conectadas via WAHA não usam templates — envie texto livre.',
    422
  )
}
if (!provider.capabilities.supportsInteractive && messageType === 'interactive') {
  throw new SendMessageError(
    'unsupported_by_provider',
    'Mensagens interativas não são suportadas pelo provedor WAHA.',
    422
  )
}
```

(Adicionar `'unsupported_by_provider'` à union de códigos de `SendMessageError` se ela for tipada.)

- [ ] **Step 3: Reescrever os ramos comuns do `attempt`**

Dentro de `attempt` (linhas ~332-396), os ramos de **mídia** e **texto** passam a usar o provedor; os ramos **template** e **interactive** ficam como estão (só executam com Meta, garantido pela guarda do Step 2):

```typescript
    if (isMediaKind) {
      const result = await provider.sendMedia({
        to: phone,
        kind: messageType as MediaKind,
        mediaUrl: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        replyToExternalId: contextMessageId,
      });
      return result.messageId;
    }
    // ... ramo interactive intocado ...
    const result = await provider.sendText({
      to: phone,
      text: contentText!,
      replyToExternalId: contextMessageId,
    });
    return result.messageId;
```

O retry de `phoneVariants` ao redor do `attempt` não muda (o erro "recipient not allowed" é específico da Meta e nunca casa em erros WAHA — comportamento correto por construção).

- [ ] **Step 4: Testes + typecheck**

Run: `npm test && npm run typecheck`
Expected: suíte existente PASS (nenhum teste atual cobre `attempt` diretamente, mas o typecheck pega quebras de assinatura).

- [ ] **Step 5: Verificação manual do caminho Meta**

Com o dev server rodando e a conta Meta conectada (se houver), enviar uma mensagem de texto pelo inbox e confirmar entrega. Sem conta Meta disponível, conferir que `GET /api/whatsapp/config` continua respondendo como antes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/whatsapp/send-message.ts
git commit -m "feat: envio do inbox despacha texto/mídia pelo provedor resolvido"
```

---

### Task 5: Despacho por provedor nas automações

**Files:**
- Modify: `src/lib/automations/meta-send.ts:143-162` (função `sendViaMeta`)

**Interfaces:**
- Consumes: `resolveProvider` (Task 3).
- Produces: `engineSendText` funciona em conta WAHA; `engineSendTemplate` em conta WAHA lança `Error('automação com template não suportada em conta WAHA')` (o motor já loga falhas por passo).

- [ ] **Step 1: Trocar o miolo do `attempt` interno**

Em `sendViaMeta` (linha 143 em diante), substituir:

```typescript
  const accessToken = decrypt(config.access_token)

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') { /* sendTemplateMessage... */ }
    const r = await sendTextMessage({ /* ... */ })
    return r.messageId
  }
```

por:

```typescript
  const accessToken = config.provider === 'waha' ? null : decrypt(config.access_token)
  const provider = resolveProvider(config, accessToken)

  if (input.kind === 'template' && !provider.capabilities.supportsTemplates) {
    throw new Error('automação com template não suportada em conta WAHA — use um passo de texto')
  }

  const attempt = async (phone: string): Promise<string> => {
    if (input.kind === 'template') {
      const r = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken: accessToken!,
        to: phone,
        templateName: input.templateName,
        language: input.language,
        params: input.params,
      })
      return r.messageId
    }
    const r = await provider.sendText({ to: phone, text: input.text })
    return r.messageId
  }
```

Import no topo: `import { resolveProvider } from '@/lib/whatsapp/providers/resolve'` (e remover o import de `sendTextMessage`, que deixa de ser usado).

- [ ] **Step 2: Testes + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/automations/meta-send.ts
git commit -m "feat: motor de automações envia texto pelo provedor resolvido"
```

---

### Task 6: Despacho por provedor nos fluxos

**Files:**
- Modify: `src/lib/flows/meta-send.ts` (`engineSendText` linha 65, `engineSendMedia` linha 175; interativos 304/314 ganham só a guarda)

**Interfaces:**
- Consumes: `resolveProvider` (Task 3).
- Produces: nós de texto e mídia de fluxos funcionam em conta WAHA; `engineSendInteractiveButtons/List` em conta WAHA lançam `Error('nó interativo não suportado em conta WAHA (fallback chega na fase 3)')`.

- [ ] **Step 1: Aplicar o mesmo padrão da Task 5**

Em `engineSendText` e `engineSendMedia`: onde hoje há `const accessToken = decrypt(config.access_token)` seguido de chamadas diretas a `sendTextMessage`/`sendMediaMessage`, trocar pelo par `accessToken`-condicional + `resolveProvider` e chamar `provider.sendText(...)` / `provider.sendMedia(...)` com os mesmos argumentos mapeados (mesma correspondência de campos da Task 4 Step 3). O restante de cada função (lookup account-scoped, variantes de telefone, INSERT em `messages` com `sender_type='bot'`) não muda.

Em `engineSendInteractiveButtons` e `engineSendInteractiveList`, logo após carregar o config:

```typescript
  if (config.provider === 'waha') {
    throw new Error('nó interativo não suportado em conta WAHA (fallback chega na fase 3)')
  }
```

- [ ] **Step 2: Testes + typecheck + commit**

Run: `npm test && npm run typecheck` → PASS.

```bash
git add src/lib/flows/meta-send.ts
git commit -m "feat: fluxos enviam texto/mídia pelo provedor resolvido"
```

---

### Task 7: Extração do pipeline inbound compartilhado

**Files:**
- Create: `src/lib/whatsapp/inbound.ts`
- Modify: `src/app/api/whatsapp/webhook/route.ts` (mover helpers; `processMessage` linha 560 vira wrapper fino)
- Test: `src/lib/whatsapp/inbound.test.ts`

**Interfaces:**
- Produces (usado pela Task 8):

```typescript
export interface NormalizedInboundMessage {
  externalId: string            // wamid (Meta) ou id WAHA — vai em messages.message_id
  fromPhone: string             // dígitos, sem '+'
  contactName: string | null
  contentType: 'text'|'image'|'document'|'audio'|'video'|'location'|'interactive'
  contentText: string | null
  mediaUrl: string | null       // URL já resolvida/proxied, pronta pra gravar
  timestamp: Date
  replyToExternalId: string | null
  interactiveReplyId: string | null
  fromMe: boolean               // eco de mensagem enviada pelo próprio número
}
export async function persistInboundMessage(
  normalized: NormalizedInboundMessage,
  accountId: string,
  configOwnerUserId: string,
): Promise<void>
export function isValidStatusTransition(from: string | null, to: string): boolean  // movida
export async function applyStatusByExternalId(externalId: string, status: 'sent'|'delivered'|'read'|'failed'): Promise<void>
```

Este é o passo mais delicado do plano: é uma **movimentação mecânica** de código que funciona. Regra: recortar/colar sem editar lógica, só trocando leituras de `message.*` (formato Meta) pelos campos de `NormalizedInboundMessage`.

- [ ] **Step 1: Criar `inbound.ts` movendo os helpers**

Mover de `src/app/api/whatsapp/webhook/route.ts` para `src/lib/whatsapp/inbound.ts`, com exports:
- `findOrCreateContact` (linha ~984) e `findOrCreateConversation` (linha ~1044), inalteradas;
- `lookupInternalIdByMetaId` (renomear para `lookupInternalIdByExternalId` — mesma query em `messages.message_id`);
- `RECIPIENT_STATUS_LADDER` (linha 319), `isValidStatusTransition` (linha 338) e o corpo de `handleStatusUpdate` (linha 352) reempacotado como `applyStatusByExternalId(externalId, status)` — a parte Meta-específica (iterar `value.statuses`, extrair `status.id`/`status.status`) fica na rota; o espelhamento em `messages` + `broadcast_recipients` + fan-out `message.status_updated` vai para a lib;
- o miolo de `processMessage` (linhas 560-820: findOrCreate*, dispatch `conversation.created`, INSERT em `messages`, UPDATE em `conversations`, `flagBroadcastReplyIfAny`, dispatch de flows/automações/IA/webhooks) como `persistInboundMessage(normalized, accountId, configOwnerUserId)`, com estas trocas pontuais:
  - `message.id` → `normalized.externalId`; `message.from` → `normalized.fromPhone`; `contact.profile.name` → `normalized.contactName`
  - o bloco `parseMessageContent` (Meta-específico, linha ~615) **fica na rota Meta** — `persistInboundMessage` recebe `contentText/mediaUrl/contentType` prontos
  - o mapeamento `ALLOWED_CONTENT_TYPES` fica na rota Meta (o tipo normalizado já chega válido)
  - `new Date(parseInt(message.timestamp) * 1000)` → `normalized.timestamp`
  - **novo (spec, eco fromMe):** logo após resolver a conversa, se `normalized.fromMe === true`: primeiro `SELECT id FROM messages WHERE message_id = externalId LIMIT 1` — se existir, retornar (é eco de envio do próprio CRM); senão INSERT com `sender_type: 'agent'`, sem incrementar `unread_count`, e **sem** disparar flows/automações/IA (return antes desses blocos)
- a rota Meta importa tudo de `@/lib/whatsapp/inbound` e `processMessage` vira: reação → `handleReaction` local (inalterado); senão `parseMessageContent` + montar `NormalizedInboundMessage` com `fromMe: false` + `persistInboundMessage`.

- [ ] **Step 2: Teste de regressão da transição de status**

```typescript
// src/lib/whatsapp/inbound.test.ts
import { describe, it, expect } from 'vitest'
import { isValidStatusTransition } from './inbound'

describe('isValidStatusTransition (movida do webhook)', () => {
  it('sobe a escada', () => {
    expect(isValidStatusTransition('pending', 'sent')).toBe(true)
    expect(isValidStatusTransition('sent', 'delivered')).toBe(true)
    expect(isValidStatusTransition('delivered', 'read')).toBe(true)
  })
  it('não desce nem falha tarde', () => {
    expect(isValidStatusTransition('read', 'delivered')).toBe(false)
    expect(isValidStatusTransition('delivered', 'failed')).toBe(false)
  })
})
```

- [ ] **Step 3: Rodar tudo**

Run: `npx vitest run && npm run typecheck`
Expected: PASS. Se a suíte não cobrir o webhook, fazer verificação manual: com o dev server rodando, `curl -X POST localhost:3000/api/whatsapp/webhook -d '{}'` deve retornar 401 (assinatura ausente) como antes da mudança.

- [ ] **Step 4: Commit**

```bash
git add src/lib/whatsapp/inbound.ts src/lib/whatsapp/inbound.test.ts src/app/api/whatsapp/webhook/route.ts
git commit -m "refactor: extrai pipeline inbound compartilhado do webhook Meta"
```

---

### Task 8: Webhook da WAHA

**Files:**
- Create: `src/app/api/whatsapp/webhook/waha/route.ts`
- Create: `src/lib/whatsapp/waha-webhook.ts` (normalização e HMAC — separado da rota para ser testável)
- Create: `src/app/api/whatsapp/waha/media/route.ts` (proxy de mídia inbound)
- Test: `src/lib/whatsapp/waha-webhook.test.ts`

**Interfaces:**
- Consumes: `persistInboundMessage`, `applyStatusByExternalId`, `lookupInternalIdByExternalId` (Task 7); `downloadWahaMedia`, `fromChatId` (Task 2).
- Produces: rota `POST /api/whatsapp/webhook/waha`; helpers `verifyWahaHmac(rawBody, header): boolean`, `normalizeWahaMessage(payload, mediaProxyPath): NormalizedInboundMessage | null`, `mapAckToStatus(ack): 'sent'|'delivered'|'read'|'failed'|null`.

- [ ] **Step 1: Testes que falham**

```typescript
// src/lib/whatsapp/waha-webhook.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'

describe('waha-webhook helpers', () => {
  beforeEach(() => vi.stubEnv('WAHA_WEBHOOK_SECRET', 'segredo'))
  afterEach(() => vi.unstubAllEnvs())

  it('verifyWahaHmac aceita assinatura correta (sha512) e rejeita errada', async () => {
    const { verifyWahaHmac } = await import('./waha-webhook')
    const body = '{"event":"message"}'
    const good = crypto.createHmac('sha512', 'segredo').update(body).digest('hex')
    expect(verifyWahaHmac(body, good)).toBe(true)
    expect(verifyWahaHmac(body, 'deadbeef')).toBe(false)
    expect(verifyWahaHmac(body, null)).toBe(false)
  })

  it('mapAckToStatus mapeia a escala da WAHA', async () => {
    const { mapAckToStatus } = await import('./waha-webhook')
    expect(mapAckToStatus(1)).toBe('sent')
    expect(mapAckToStatus(2)).toBe('delivered')
    expect(mapAckToStatus(3)).toBe('read')
    expect(mapAckToStatus(4)).toBe('read')     // PLAYED conta como lida
    expect(mapAckToStatus(-1)).toBe('failed')
    expect(mapAckToStatus(0)).toBe(null)       // PENDING não regride a escada
  })

  it('normalizeWahaMessage converte texto simples', async () => {
    const { normalizeWahaMessage } = await import('./waha-webhook')
    const n = normalizeWahaMessage({
      id: 'false_5511999999999@c.us_ABC',
      from: '5511999999999@c.us',
      fromMe: false,
      body: 'olá',
      hasMedia: false,
      timestamp: 1767998400,
      _data: { notifyName: 'Fulano' },
    }, '/api/whatsapp/waha/media')
    expect(n).toMatchObject({
      externalId: 'false_5511999999999@c.us_ABC',
      fromPhone: '5511999999999',
      contactName: 'Fulano',
      contentType: 'text',
      contentText: 'olá',
      mediaUrl: null,
      fromMe: false,
    })
    expect(n!.timestamp.toISOString()).toBe('2026-01-09T22:40:00.000Z')
  })

  it('normalizeWahaMessage converte mídia para URL do proxy', async () => {
    const { normalizeWahaMessage } = await import('./waha-webhook')
    const n = normalizeWahaMessage({
      id: 'x', from: '55@c.us', fromMe: false, body: 'legenda',
      hasMedia: true,
      media: { url: 'http://waha.local:3001/api/files/x.jpg', mimetype: 'image/jpeg', filename: null },
      timestamp: 1767998400,
    }, '/api/whatsapp/waha/media')
    expect(n!.contentType).toBe('image')
    expect(n!.mediaUrl).toBe('/api/whatsapp/waha/media?src=' + encodeURIComponent('http://waha.local:3001/api/files/x.jpg'))
    expect(n!.contentText).toBe('legenda')
  })

  it('ignora eventos de grupo (sufixo @g.us)', async () => {
    const { normalizeWahaMessage } = await import('./waha-webhook')
    const n = normalizeWahaMessage({ id: 'x', from: '5511-123@g.us', fromMe: false, body: 'oi',
      hasMedia: false, timestamp: 1 }, '/api/whatsapp/waha/media')
    expect(n).toBe(null)
  })
})
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/whatsapp/waha-webhook.test.ts` → FAIL (módulo inexistente).

- [ ] **Step 3: Implementar helpers**

```typescript
// src/lib/whatsapp/waha-webhook.ts
// Normalização de eventos do webhook WAHA -> pipeline inbound compartilhado.
import crypto from 'node:crypto'
import type { NormalizedInboundMessage } from '@/lib/whatsapp/inbound'
import { fromChatId } from '@/lib/whatsapp/waha-api'

/** HMAC-SHA512 hex do corpo cru, chave WAHA_WEBHOOK_SECRET. Fail-closed. */
export function verifyWahaHmac(rawBody: string, headerValue: string | null): boolean {
  const secret = process.env.WAHA_WEBHOOK_SECRET
  if (!secret || !headerValue) return false
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex')
  const a = Buffer.from(expected, 'hex')
  let b: Buffer
  try { b = Buffer.from(headerValue, 'hex') } catch { return false }
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Escala de ack da WAHA: -1 ERROR, 0 PENDING, 1 SERVER, 2 DEVICE, 3 READ, 4 PLAYED. */
export function mapAckToStatus(ack: number): 'sent' | 'delivered' | 'read' | 'failed' | null {
  if (ack === -1) return 'failed'
  if (ack === 1) return 'sent'
  if (ack === 2) return 'delivered'
  if (ack === 3 || ack === 4) return 'read'
  return null
}

interface WahaMessagePayload {
  id: string
  from: string
  fromMe: boolean
  body?: string
  hasMedia?: boolean
  media?: { url: string; mimetype?: string | null; filename?: string | null } | null
  timestamp: number
  replyTo?: string | null
  _data?: { notifyName?: string } | null
}

const MIME_TO_CONTENT: Array<[RegExp, NormalizedInboundMessage['contentType']]> = [
  [/^image\//, 'image'],
  [/^video\//, 'video'],
  [/^audio\//, 'audio'],
]

/** Retorna null para eventos que a fase 1 não ingere (grupos, status@broadcast). */
export function normalizeWahaMessage(
  payload: WahaMessagePayload,
  mediaProxyPath: string,
): NormalizedInboundMessage | null {
  // fromMe: o interlocutor é o 'to'; inbound: é o 'from'.
  const counterpart = payload.fromMe ? (payload as { to?: string }).to ?? payload.from : payload.from
  if (!counterpart.endsWith('@c.us') && !counterpart.endsWith('@s.whatsapp.net')) return null

  let contentType: NormalizedInboundMessage['contentType'] = 'text'
  let mediaUrl: string | null = null
  if (payload.hasMedia && payload.media?.url) {
    const mime = payload.media.mimetype ?? ''
    contentType = MIME_TO_CONTENT.find(([re]) => re.test(mime))?.[1] ?? 'document'
    mediaUrl = `${mediaProxyPath}?src=${encodeURIComponent(payload.media.url)}`
  }

  return {
    externalId: payload.id,
    fromPhone: fromChatId(counterpart),
    contactName: payload._data?.notifyName ?? null,
    contentType,
    contentText: payload.body || null,
    mediaUrl,
    timestamp: new Date(payload.timestamp * 1000),
    replyToExternalId: payload.replyTo ?? null,
    interactiveReplyId: null,
    fromMe: payload.fromMe,
  }
}
```

- [ ] **Step 4: Rodar os testes dos helpers**

Run: `npx vitest run src/lib/whatsapp/waha-webhook.test.ts` → PASS.

- [ ] **Step 5: Implementar a rota do webhook**

```typescript
// src/app/api/whatsapp/webhook/waha/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { verifyWahaHmac, normalizeWahaMessage, mapAckToStatus } from '@/lib/whatsapp/waha-webhook'
import { persistInboundMessage, applyStatusByExternalId } from '@/lib/whatsapp/inbound'
import { wahaEnabled } from '@/lib/whatsapp/waha-api'

export const maxDuration = 60

export async function POST(request: NextRequest) {
  if (!wahaEnabled()) return NextResponse.json({ error: 'WAHA not configured' }, { status: 501 })

  const rawBody = await request.text()
  const hmac = request.headers.get('x-webhook-hmac')
  if (!verifyWahaHmac(rawBody, hmac)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let event: { event: string; session: string; payload: unknown }
  try { event = JSON.parse(rawBody) } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Resolve a conta pela sessão — espelha o roteamento por phone_number_id do webhook Meta.
  const db = supabaseAdmin()
  const { data: config } = await db
    .from('whatsapp_config')
    .select('account_id, user_id, waha_session, status')
    .eq('waha_session', event.session)
    .eq('provider', 'waha')
    .maybeSingle()
  if (!config) {
    console.warn('[webhook/waha] sessão sem config, descartando:', event.session)
    return NextResponse.json({ received: true })
  }

  after(async () => {
    try {
      if (event.event === 'message') {
        const normalized = normalizeWahaMessage(
          event.payload as Parameters<typeof normalizeWahaMessage>[0],
          '/api/whatsapp/waha/media',
        )
        if (normalized) await persistInboundMessage(normalized, config.account_id, config.user_id)
      } else if (event.event === 'message.ack') {
        const p = event.payload as { id: string; ack: number }
        const status = mapAckToStatus(p.ack)
        if (status) await applyStatusByExternalId(p.id, status)
      } else if (event.event === 'session.status') {
        const p = event.payload as { status: string }
        if (p.status === 'STOPPED' || p.status === 'FAILED') {
          await db.from('whatsapp_config')
            .update({ status: 'disconnected' })
            .eq('waha_session', event.session)
          await db.from('notifications').insert({
            account_id: config.account_id,
            user_id: config.user_id,
            type: 'whatsapp_disconnected',
            title: 'Sessão do WhatsApp desconectada',
            body: 'Sua sessão WAHA caiu — reconecte pelo QR Code em Configurações → WhatsApp.',
          })
        } else if (p.status === 'WORKING') {
          await db.from('whatsapp_config')
            .update({ status: 'connected' })
            .eq('waha_session', event.session)
        }
      }
    } catch (err) {
      console.error('[webhook/waha] processamento falhou:', err)
    }
  })

  return NextResponse.json({ received: true })
}
```

- [ ] **Step 6: Implementar o proxy de mídia**

```typescript
// src/app/api/whatsapp/waha/media/route.ts
// Proxy autenticado da mídia hospedada no servidor WAHA. O navegador
// nunca fala com a WAHA nem vê a API key. Auth por sessão do dashboard.
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { downloadWahaMedia } from '@/lib/whatsapp/waha-api'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const src = request.nextUrl.searchParams.get('src')
  if (!src) return NextResponse.json({ error: 'src required' }, { status: 400 })

  try {
    const upstream = await downloadWahaMedia({ url: src })  // valida host = WAHA_URL
    return new NextResponse(upstream.body, {
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return NextResponse.json({ error: 'media unavailable' }, { status: 502 })
  }
}
```

(Conferir o caminho de import do server client: como os outros route handlers fazem — ex.: `src/app/api/whatsapp/config/route.ts` usa `createClient` de `@/lib/supabase/server`.)

- [ ] **Step 7: Rodar tudo + commit**

Run: `npx vitest run && npm run typecheck` → PASS.

```bash
git add src/app/api/whatsapp/webhook/waha/ src/lib/whatsapp/waha-webhook.ts src/lib/whatsapp/waha-webhook.test.ts src/app/api/whatsapp/waha/media/
git commit -m "feat: webhook WAHA (HMAC, mensagens, acks, status de sessão) + proxy de mídia"
```

---

### Task 9: Rotas de sessão/QR

**Files:**
- Create: `src/app/api/whatsapp/waha/session/route.ts` (POST cria+inicia; GET status; DELETE desconecta)
- Create: `src/app/api/whatsapp/waha/session/qr/route.ts` (GET imagem PNG)

**Interfaces:**
- Consumes: `createSession`, `getSession`, `getQrPng`, `logoutAndDelete`, `wahaSessionName`, `fromChatId`, `wahaEnabled` (Task 2).
- Produces (consumido pela UI na Task 11):
  - `POST /api/whatsapp/waha/session` → `{ session: string }` (409 se já existe config Meta conectada; 501 sem WAHA_URL)
  - `GET /api/whatsapp/waha/session` → `{ status: WahaSessionInfo['status'], phone: string | null }` — quando detecta `WORKING` pela primeira vez, grava a config (upsert `provider='waha'`, `waha_session`, `waha_phone`, `status='connected'`, `connected_at`)
  - `GET /api/whatsapp/waha/session/qr` → `image/png` (400 se sessão não está em `SCAN_QR_CODE`)
  - `DELETE /api/whatsapp/waha/session` → logout+delete na WAHA e apaga a linha de `whatsapp_config`

Padrões a copiar de `src/app/api/whatsapp/config/route.ts`: resolução de usuário/conta (`createClient` + `resolveAccountId`), exigência de papel admin+ (mesmo helper que o POST do config usa — conferir no arquivo) e escrita via service-role quando preciso cruzar RLS.

- [ ] **Step 1: Implementar `session/route.ts`**

```typescript
// src/app/api/whatsapp/waha/session/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveAccountId } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  wahaEnabled, wahaSessionName, createSession, getSession, logoutAndDelete, fromChatId,
} from '@/lib/whatsapp/waha-api'

async function requireAccount() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) return { error: NextResponse.json({ error: 'No account' }, { status: 400 }) }
  return { user, accountId }
}

export async function POST() {
  if (!wahaEnabled()) return NextResponse.json({ error: 'waha_not_configured' }, { status: 501 })
  const ctx = await requireAccount()
  if ('error' in ctx) return ctx.error

  // Config Meta ativa bloqueia — o usuário desconecta primeiro (regra da spec).
  const { data: existing } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('provider, status')
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (existing && existing.provider === 'meta') {
    return NextResponse.json({ error: 'meta_config_exists' }, { status: 409 })
  }

  const session = wahaSessionName(ctx.accountId)
  const site = process.env.NEXT_PUBLIC_SITE_URL
  if (!site) return NextResponse.json({ error: 'site_url_required',
    message: 'Defina NEXT_PUBLIC_SITE_URL para o servidor WAHA alcançar o CRM.' }, { status: 500 })
  await createSession({ session, webhookUrl: `${site}/api/whatsapp/webhook/waha` })
  return NextResponse.json({ session })
}

export async function GET() {
  if (!wahaEnabled()) return NextResponse.json({ error: 'waha_not_configured' }, { status: 501 })
  const ctx = await requireAccount()
  if ('error' in ctx) return ctx.error

  const session = wahaSessionName(ctx.accountId)
  let info
  try { info = await getSession({ session }) } catch {
    return NextResponse.json({ status: 'STOPPED', phone: null })
  }

  const phone = info.me?.id ? fromChatId(info.me.id) : null
  if (info.status === 'WORKING' && phone) {
    // Grava/atualiza a config na primeira vez que a sessão fica ativa.
    await supabaseAdmin().from('whatsapp_config').upsert({
      account_id: ctx.accountId,
      user_id: ctx.user.id,
      provider: 'waha',
      waha_session: session,
      waha_phone: phone,
      phone_number_id: null,
      access_token: 'waha',        // NOT NULL no schema; valor sentinela nunca usado
      status: 'connected',
      connected_at: new Date().toISOString(),
    }, { onConflict: 'account_id' })
  }
  return NextResponse.json({ status: info.status, phone })
}

export async function DELETE() {
  if (!wahaEnabled()) return NextResponse.json({ error: 'waha_not_configured' }, { status: 501 })
  const ctx = await requireAccount()
  if ('error' in ctx) return ctx.error

  const session = wahaSessionName(ctx.accountId)
  await logoutAndDelete({ session })
  await supabaseAdmin().from('whatsapp_config')
    .delete()
    .eq('account_id', ctx.accountId)
    .eq('provider', 'waha')
  return NextResponse.json({ ok: true })
}
```

Nota: conferir se `resolveAccountId` vive em `@/lib/auth/account` (é o helper que o config route usa — copiar o import de lá).

- [ ] **Step 2: Implementar `session/qr/route.ts`**

```typescript
// src/app/api/whatsapp/waha/session/qr/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveAccountId } from '@/lib/auth/account'
import { wahaEnabled, wahaSessionName, getQrPng } from '@/lib/whatsapp/waha-api'

export async function GET() {
  if (!wahaEnabled()) return NextResponse.json({ error: 'waha_not_configured' }, { status: 501 })
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) return NextResponse.json({ error: 'No account' }, { status: 400 })

  try {
    const png = await getQrPng({ session: wahaSessionName(accountId) })
    return new NextResponse(png, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
    })
  } catch {
    return NextResponse.json({ error: 'qr_unavailable' }, { status: 400 })
  }
}
```

- [ ] **Step 3: Teste manual com WAHA local**

```bash
docker run -d --name waha -p 3001:3000 \
  -e WHATSAPP_API_KEY=test-key devlikeapro/waha
# .env.local: WAHA_URL=http://localhost:3001  WAHA_API_KEY=test-key
# WAHA_WEBHOOK_SECRET=<openssl rand -hex 32>  NEXT_PUBLIC_SITE_URL=http://host.docker.internal:3000
```

Logado no dashboard: `POST /api/whatsapp/waha/session` → 200 `{session}`; `GET .../session` → `SCAN_QR_CODE`; `GET .../session/qr` → PNG abre no navegador.

- [ ] **Step 4: Typecheck + commit**

```bash
npm run typecheck
git add src/app/api/whatsapp/waha/session/
git commit -m "feat: rotas de sessão WAHA (criar, status com auto-vínculo, QR, desconectar)"
```

---

### Task 10: Capacidades e health check no `GET /api/whatsapp/config`

**Files:**
- Modify: `src/app/api/whatsapp/config/route.ts` (GET linhas 63-160; DELETE linha 441)

**Interfaces:**
- Consumes: `CAPABILITIES` (Task 3), `getSession`/`wahaEnabled`/`logoutAndDelete` (Task 2).
- Produces (consumido pela UI, Tasks 11-12): todo retorno do GET ganha `provider: 'meta'|'waha'|null`, `capabilities: ProviderCapabilities|null` e `waha_available: boolean`.

- [ ] **Step 1: Ramificar o GET por provedor**

Depois do fetch do config (linha ~88), mudar o `select` para incluir os campos novos: `'phone_number_id, access_token, status, provider, waha_session, waha_phone'`. Nos retornos existentes de "sem config": incluir `provider: null, capabilities: null, waha_available: wahaEnabled()`.

Antes do bloco de decrypt (linha ~114), inserir o ramo WAHA:

```typescript
    if (config.provider === 'waha') {
      try {
        const info = await getSession({ session: config.waha_session! })
        return NextResponse.json({
          connected: info.status === 'WORKING',
          provider: 'waha',
          capabilities: CAPABILITIES.waha,
          waha_available: true,
          waha_status: info.status,
          phone: config.waha_phone,
          ...(info.status !== 'WORKING' && {
            reason: 'waha_session_down',
            message: 'A sessão WAHA não está ativa — reconecte pelo QR Code.',
          }),
        })
      } catch {
        return NextResponse.json({
          connected: false,
          provider: 'waha',
          capabilities: CAPABILITIES.waha,
          waha_available: wahaEnabled(),
          reason: 'waha_server_unreachable',
          message: 'Servidor WAHA inacessível — verifique WAHA_URL e se o container está no ar.',
        })
      }
    }
```

E nos retornos do ramo Meta existente (connected/token_corrupted/meta_api_error), adicionar `provider: 'meta', capabilities: CAPABILITIES.meta, waha_available: wahaEnabled()` — sem alterar mais nada.

- [ ] **Step 2: DELETE ciente de WAHA**

No DELETE (linha 441), antes de apagar a linha: se `config.provider === 'waha'` e `wahaEnabled()`, chamar `logoutAndDelete({ session: config.waha_session! })` em try/catch (falha na WAHA não impede a limpeza local).

- [ ] **Step 3: Testes + typecheck + commit**

Run: `npm test && npm run typecheck` → PASS.

```bash
git add src/app/api/whatsapp/config/route.ts
git commit -m "feat: config GET/DELETE cientes de provedor (capacidades + health WAHA)"
```

---

### Task 11: UI de Configurações — seletor de provedor + painel QR

**Files:**
- Create: `src/components/settings/whatsapp-waha-config.tsx`
- Modify: `src/components/settings/whatsapp-config.tsx` (envolver com o seletor; o formulário Meta atual vira o painel do cartão "Meta")
- Modify: `messages/en.json` e `messages/pt.json` (namespace `Settings.waha`)

**Interfaces:**
- Consumes: rotas da Task 9 e GET da Task 10.
- Produces: painel WAHA com QR + status; seletor só aparece quando `waha_available === true`; seção Templates oculta quando `provider === 'waha'` (a flag vem do mesmo GET que a tela já consulta na linha ~139).

- [ ] **Step 1: Strings i18n (nas DUAS línguas)**

`messages/en.json` → dentro de `"Settings"`, irmã de `"whatsapp"`:

```json
"waha": {
  "providerTitle": "Connection provider",
  "providerMeta": "Meta Official API",
  "providerMetaHint": "Cloud API with approved templates and 24h window",
  "providerWaha": "WAHA — QR Code",
  "providerWahaHint": "Unofficial connection; scan with your phone",
  "connect": "Connect via QR Code",
  "connecting": "Starting session…",
  "scanTitle": "Scan the QR Code",
  "scanHint": "WhatsApp → Settings → Linked devices → Link a device",
  "qrExpiredHint": "The code refreshes automatically every 20 seconds.",
  "connectedAs": "Connected as {phone}",
  "disconnect": "Disconnect",
  "disconnectConfirm": "Disconnect this number? Conversations and contacts are kept.",
  "sessionDown": "Session is not active — reconnect via QR Code.",
  "serverUnreachable": "WAHA server unreachable — check the WAHA_URL environment variable.",
  "switchBlocked": "Disconnect the current provider before switching.",
  "banWarning": "Unofficial connection: WhatsApp may ban numbers that send bulk unsolicited messages. Use responsibly."
}
```

`messages/pt.json` → mesma estrutura:

```json
"waha": {
  "providerTitle": "Provedor de conexão",
  "providerMeta": "API Oficial da Meta",
  "providerMetaHint": "Cloud API com modelos aprovados e janela de 24h",
  "providerWaha": "WAHA — QR Code",
  "providerWahaHint": "Conexão não oficial; escaneie com o celular",
  "connect": "Conectar via QR Code",
  "connecting": "Iniciando sessão…",
  "scanTitle": "Escaneie o QR Code",
  "scanHint": "WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho",
  "qrExpiredHint": "O código é renovado automaticamente a cada 20 segundos.",
  "connectedAs": "Conectado como {phone}",
  "disconnect": "Desconectar",
  "disconnectConfirm": "Desconectar este número? Conversas e contatos são preservados.",
  "sessionDown": "A sessão não está ativa — reconecte pelo QR Code.",
  "serverUnreachable": "Servidor WAHA inacessível — verifique a variável WAHA_URL.",
  "switchBlocked": "Desconecte o provedor atual antes de trocar.",
  "banWarning": "Conexão não oficial: o WhatsApp pode banir números que disparam mensagens em massa não solicitadas. Use com responsabilidade."
}
```

- [ ] **Step 2: Componente do painel WAHA**

```tsx
// src/components/settings/whatsapp-waha-config.tsx
'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'   // conferir path dos primitivos usados em whatsapp-config.tsx e reusar os mesmos

type WahaStatus = 'IDLE' | 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'STOPPED' | 'FAILED'

export function WhatsAppWahaConfig({ onChanged }: { onChanged?: () => void }) {
  const t = useTranslations('Settings.waha')
  const [status, setStatus] = useState<WahaStatus>('IDLE')
  const [phone, setPhone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [qrBust, setQrBust] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refreshStatus = useCallback(async () => {
    const res = await fetch('/api/whatsapp/waha/session')
    if (!res.ok) return
    const data = await res.json()
    setStatus(data.status ?? 'STOPPED')
    setPhone(data.phone ?? null)
    if (data.status === 'WORKING') onChanged?.()
  }, [onChanged])

  // Polling: status a cada 3s enquanto aguarda o scan; QR re-renderiza a cada 20s.
  useEffect(() => {
    if (status !== 'SCAN_QR_CODE' && status !== 'STARTING') return
    pollRef.current = setInterval(refreshStatus, 3000)
    const qrTimer = setInterval(() => setQrBust((n) => n + 1), 20000)
    return () => { if (pollRef.current) clearInterval(pollRef.current); clearInterval(qrTimer) }
  }, [status, refreshStatus])

  useEffect(() => { void refreshStatus() }, [refreshStatus])

  const connect = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/whatsapp/waha/session', { method: 'POST' })
      if (res.ok) { setStatus('STARTING'); await refreshStatus() }
    } finally { setBusy(false) }
  }

  const disconnect = async () => {
    if (!window.confirm(t('disconnectConfirm'))) return
    setBusy(true)
    try {
      await fetch('/api/whatsapp/waha/session', { method: 'DELETE' })
      setStatus('IDLE'); setPhone(null); onChanged?.()
    } finally { setBusy(false) }
  }

  if (status === 'WORKING' && phone) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">{t('connectedAs', { phone: `+${phone}` })}</p>
        <p className="text-xs text-muted-foreground">{t('banWarning')}</p>
        <Button variant="destructive" onClick={disconnect} disabled={busy}>{t('disconnect')}</Button>
      </div>
    )
  }

  if (status === 'SCAN_QR_CODE') {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">{t('scanTitle')}</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- PNG dinâmico de rota interna */}
        <img src={`/api/whatsapp/waha/session/qr?t=${qrBust}`} alt="QR Code" width={264} height={264} />
        <p className="text-xs text-muted-foreground">{t('scanHint')}</p>
        <p className="text-xs text-muted-foreground">{t('qrExpiredHint')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {(status === 'STOPPED' || status === 'FAILED') && (
        <p className="text-sm text-destructive">{t('sessionDown')}</p>
      )}
      <p className="text-xs text-muted-foreground">{t('banWarning')}</p>
      <Button onClick={connect} disabled={busy}>
        {busy || status === 'STARTING' ? t('connecting') : t('connect')}
      </Button>
    </div>
  )
}
```

- [ ] **Step 3: Seletor em `whatsapp-config.tsx`**

No componente existente: o GET que ele já faz (linha ~139) agora retorna `provider` e `waha_available`. Adicionar estado `selectedProvider: 'meta' | 'waha'` inicializado do GET (`provider` salvo, senão `'meta'`). Renderizar acima do formulário atual, **somente quando `waha_available`**, dois cartões clicáveis (mesmos primitivos de card usados no arquivo) com `t('Settings.waha.providerMeta')`/hint e `providerWaha`/hint; cartão desabilitado com tooltip `switchBlocked` quando o provedor oposto está com config salva. Corpo condicional: `selectedProvider === 'waha' ? <WhatsAppWahaConfig onChanged={reloadStatus}/> : <formulário Meta atual sem alterações>`.

Ocultar templates para WAHA: localizar onde a seção/aba de Templates é montada (rail em `src/components/settings/settings-sections.ts:29,55` — a entrada "templates") e condicionar à capacidade: a página de settings já busca o status; propagar `capabilities.supportsTemplates === false` para esconder a entrada (ou, mais simples, dentro do componente de templates renderizar aviso "não disponível para o provedor atual" — escolher o caminho que exigir menos fios novos; documentar a escolha no commit).

- [ ] **Step 4: Validar visualmente**

`npm run dev` → Configurações → WhatsApp: sem `WAHA_URL` no env, tela idêntica à atual; com `WAHA_URL`, seletor aparece; clicar em WAHA → Conectar → QR aparece → escanear com um número de teste → vira "Conectado como +55…". Enviar mensagem do celular de outra pessoa para o número: conversa aparece no inbox. Responder pelo inbox: chega no WhatsApp.

- [ ] **Step 5: Lint + commit**

```bash
npm run lint && npm run typecheck
git add src/components/settings/ messages/en.json messages/pt.json
git commit -m "feat: tela de Configurações com seletor de provedor e painel QR da WAHA"
```

---

### Task 12: Inbox sem janela de 24h para WAHA

**Files:**
- Modify: `src/components/inbox/message-thread.tsx:229-241`
- Modify: `src/components/inbox/message-composer.tsx:190-192` (e uso na linha ~673)

**Interfaces:**
- Consumes: `GET /api/whatsapp/config` (Task 10) — campo `capabilities.has24hWindow`.

- [ ] **Step 1: Buscar a capacidade uma vez no inbox**

Nos dois componentes, a checagem hoje é `differenceInHours(...) >= 24` pura. Criar um hook mínimo:

```typescript
// src/lib/whatsapp/use-provider-capabilities.ts
'use client'
import { useEffect, useState } from 'react'

interface Caps { supportsTemplates: boolean; has24hWindow: boolean }
let cached: Caps | null = null

export function useProviderCapabilities(): Caps | null {
  const [caps, setCaps] = useState<Caps | null>(cached)
  useEffect(() => {
    if (cached) return
    fetch('/api/whatsapp/config')
      .then((r) => r.json())
      .then((d) => { cached = d.capabilities ?? { supportsTemplates: true, has24hWindow: true }; setCaps(cached) })
      .catch(() => { cached = { supportsTemplates: true, has24hWindow: true }; setCaps(cached) })
  }, [])
  return caps
}
```

Fallback deliberado para o comportamento Meta (mais restritivo) se o fetch falhar.

- [ ] **Step 2: Aplicar nos dois componentes**

Em `message-thread.tsx` (linha ~229) e `message-composer.tsx` (linha ~190), envolver a condição existente:

```typescript
const caps = useProviderCapabilities()
// ...
const outsideWindow = (caps?.has24hWindow ?? true) && differenceInHours(now, lastCustomerMessageAt) >= 24
```

(manter os nomes de variáveis locais que os arquivos já usam; a mudança é só o `&&` com a capacidade.)

- [ ] **Step 3: Verificar + commit**

Conta WAHA: composer livre mesmo em conversa parada há dias. Conta Meta (ou sem config): banner/trava de 24h intactos.

```bash
npm run lint && npm run typecheck
git add src/components/inbox/ src/lib/whatsapp/use-provider-capabilities.ts
git commit -m "feat: inbox dispensa janela de 24h quando o provedor não a tem"
```

---

### Task 13: Verificação ponta a ponta e encerramento

**Files:** nenhum novo (checklist manual + ajustes achados).

- [ ] **Step 1: Roteiro E2E com WAHA em Docker** (container da Task 9 Step 3 no ar, número de teste em mãos)

1. Conectar via QR nas Configurações → status "Conectado como +55…".
2. Receber: mandar texto e uma foto do celular de um segundo número → aparecem no inbox (foto servida pelo proxy `/api/whatsapp/waha/media`).
3. Enviar: responder com texto e com uma imagem pelo composer → chegam no celular; status da mensagem no inbox progride para entregue/lida (acks).
4. Eco: mandar uma mensagem pelo próprio celular conectado → aparece como mensagem de agente, sem duplicar, sem disparar automação.
5. Automação: criar automação "nova mensagem → responder texto" → responde via WAHA.
6. Queda: parar o container (`docker stop waha`) → health nas Configurações mostra "Servidor WAHA inacessível"; subir de novo e desconectar pelo celular (Aparelhos conectados → sair) → notificação "Sessão do WhatsApp desconectada" aparece no sino.
7. Regressão Meta: com conta Meta (ou revisão de código dos diffs no caminho Meta), confirmar que `npm test` passa e o webhook Meta responde 401 sem assinatura.

- [ ] **Step 2: Suíte completa**

Run: `npx vitest run && npm run lint && npm run typecheck`
Expected: tudo PASS.

- [ ] **Step 3: Commit final da fase**

```bash
git add -A
git commit -m "feat: provedor WAHA fase 1 completa — QR, chat ponta a ponta, health e notificações"
```

---

## Fora deste plano (fases seguintes)

- **Plano 2:** transmissões com texto livre para WAHA (migração relaxando `broadcasts.template_name NOT NULL` + colunas de conteúdo, UI da transmissão por provedor, ritmo anti-ban com intervalo aleatório).
- **Plano 3:** fallback de nós interativos dos fluxos para lista numerada + casamento de resposta por número + aviso no construtor.
- Reações inbound via WAHA; recibos de leitura enviados; suporte a grupos — fora de escopo por decisão da spec.
