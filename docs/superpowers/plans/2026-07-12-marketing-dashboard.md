# Dashboard de Marketing — Plano de Implementação (leva 1: GA4 + Meta Ads + atribuição)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página /marketing com as métricas 1–38 da spec (GA4 + Meta Ads; Google Ads é leva 2), credenciais criptografadas em Configurações, cache de 1h, e atribuição de origem das conversas (Anúncio/Site/Direto).

**Architecture:** Clientes de API puros (fetch, sem SDKs) normalizando para shapes únicos; rota summary orquestra cache→APIs→deltas; captura de origem entra no pipeline inbound existente (ad_referral do provedor + marcador [ref:] na primeira mensagem). Spec: `docs/superpowers/specs/2026-07-12-marketing-dashboard-design.md` (lista fechada de métricas na seção 3).

**Tech Stack:** Next.js 16, Supabase, vitest, recharts (já é dependência), GA4 Data API (JWT de service account via node:crypto), Meta Graph API /insights.

## Global Constraints

- Credenciais SEMPRE via `encrypt()`/`decrypt()` de `src/lib/whatsapp/encryption.ts`; nunca em logs nem respostas JSON (só flags `configured: true`).
- Sem dependências novas de npm (JWT RS256 com `node:crypto`; gráficos com recharts existente).
- Critérios permanentes: `npx vitest run` sem falhas novas (2 pré-existentes conhecidas: date-utils/mondayIndex), `npm run typecheck`, `npm run lint`, paridade i18n en/pt por task de UI.
- Next.js 16: consultar `node_modules/next/dist/docs/` antes de rotas (AGENTS.md).
- Pipeline inbound e webhooks: mudanças ADITIVAS apenas — nada do comportamento atual de persistência muda; regressão na suíte é bloqueante.
- Migrações via Management API (token do usuário na hora; nunca commitá-lo) + registro em schema_migrations.
- Commits no branch `personalizacao-display4`, português, rodapé `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Shapes normalizados (contrato entre Tasks 2/3/5/6 — respeitar EXATAMENTE)

```typescript
// src/lib/marketing/types.ts (criado na Task 2)
export interface AdsCampaignRow { id: string; name: string; status: string;
  spend: number; impressions: number; reach: number | null; clicks: number;
  ctr: number; cpc: number; leads: number; cpl: number; frequency: number | null }
export interface AdsDaily { date: string /*YYYY-MM-DD*/; spend: number; leads: number }
export interface AdsSummary { spend: number; leads: number;
  campaigns: AdsCampaignRow[]; daily: AdsDaily[] }
export interface Ga4Summary { sessions: number; totalUsers: number; newUsers: number;
  engagementRate: number; avgSessionDurationSec: number; conversions: number;
  sources: Array<{ sourceMedium: string; sessions: number; conversions: number }>;
  topPages: Array<{ path: string; views: number }>;
  whatsappClicks: Array<{ sourceMedium: string; clicks: number }> /*evento click_whatsapp; vazio se não configurado*/ }
export interface AttributionSummary {
  byOrigin: { ad: number; site: number; direct: number };
  byAd: Array<{ adId: string | null; headline: string | null; conversations: number;
    replied: number; deals: number }>;
  bySitePage: Array<{ ref: string; conversations: number }> }
```

---

### Task 1: Migração 040 + tipos

**Files:** Create `supabase/migrations/040_marketing.sql`; Modify `src/types/index.ts`.
**Produces:** tabelas `marketing_integrations` e `marketing_cache`; colunas `conversations.ad_referral JSONB` e `conversations.site_ref TEXT`; tipos `MarketingIntegration`, campos novos em `Conversation`.

- [ ] SQL (padrão de idempotência das migrações 037–039; cabeçalho comentado):

```sql
CREATE TABLE IF NOT EXISTS marketing_integrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('ga4','meta_ads','google_ads')),
  -- credenciais criptografadas (AES-256-GCM, formato iv:ct:tag do encryption.ts)
  credentials TEXT NOT NULL,
  -- ids não-secretos (property_id, ad_account_id, customer_id)
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, platform)
);
ALTER TABLE marketing_integrations ENABLE ROW LEVEL SECURITY;
-- RLS: mesma forma das tabelas account-scoped da 017 (is_account_member)
DROP POLICY IF EXISTS marketing_integrations_all ON marketing_integrations;
CREATE POLICY marketing_integrations_all ON marketing_integrations
  FOR ALL USING (is_account_member(account_id));

CREATE TABLE IF NOT EXISTS marketing_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  period TEXT NOT NULL,          -- '7d' | '30d' | '90d'
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, platform, period)
);
ALTER TABLE marketing_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketing_cache_all ON marketing_cache;
CREATE POLICY marketing_cache_all ON marketing_cache
  FOR ALL USING (is_account_member(account_id));

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ad_referral JSONB,
  ADD COLUMN IF NOT EXISTS site_ref TEXT;
```

(Conferir na migração 017 o nome/assinatura real do helper `is_account_member`; ajustar se for outro. Trigger `set_updated_at` em marketing_integrations como as tabelas vizinhas.)
- [ ] Tipos + typecheck/vitest/lint + commit `feat: migração 040 — integrações de marketing e origem de conversas`. (Aplicação remota: controlador.)

---

### Task 2: Cliente GA4 (`src/lib/marketing/ga4.ts` + `types.ts`)

**Produces:** `ga4Summary(args: {serviceAccountJson: string; propertyId: string; period: {start: string; end: string}}): Promise<Ga4Summary>` + `types.ts` com os shapes acima.

- [ ] TDD com mock fetch (padrão waha-api.test.ts). Testes: (a) `buildGa4Jwt` (helper exportado) gera JWT RS256 com iss/scope/aud corretos — validar decodificando header/payload base64 (chave de teste RSA gerada no teste via node:crypto generateKeyPairSync); (b) troca JWT→access_token (POST oauth2.googleapis.com/token); (c) `runReport` batch: 1 chamada por relatório necessário (totais, origem/mídia, top pages, evento click_whatsapp) com dimensões/métricas EXATAS documentadas em comentário; (d) normalização de resposta fixture → `Ga4Summary`; (e) evento click_whatsapp ausente → `whatsappClicks: []` sem erro.
- [ ] Métricas/dimensões GA4 (Data API v1beta, endpoint `https://analyticsdata.googleapis.com/v1beta/properties/{id}:runReport`): totais = metrics sessions, totalUsers, newUsers, engagementRate, averageSessionDuration, keyEvents; origem = dimension sessionSourceMedium; páginas = dimension pagePath + metric screenPageViews (limit 10); cliques whatsapp = dimension sessionSourceMedium + metric eventCount com dimensionFilter eventName == 'click_whatsapp'.
- [ ] Commit `feat: cliente GA4 (JWT de service account + runReport normalizado)`.

---

### Task 3: Cliente Meta Ads (`src/lib/marketing/meta-ads.ts`)

**Produces:** `metaAdsSummary(args: {accessToken: string; adAccountId: string; period: {start: string; end: string}}): Promise<AdsSummary>`.

- [ ] TDD com mock fetch. Endpoints (Graph API v21.0, mesma META_API_VERSION do meta-api.ts): campanhas = `GET /act_{id}/insights?level=campaign&fields=campaign_id,campaign_name,spend,impressions,reach,clicks,ctr,cpc,frequency,actions&time_range={since,until}`; série diária = mesmo endpoint com `time_increment=1` e level=account; status = `GET /act_{id}/campaigns?fields=id,name,status`. Leads: extrair de `actions` o action_type 'lead' e/ou 'onsite_conversion.messaging_conversation_started_7d' (somar ambos; documentar em comentário). CPL calculado (spend/leads, 0-safe). Paginação: seguir `paging.next` até esgotar (teste com fixture paginada).
- [ ] Testes: normalização fixture→AdsSummary; leads somando os dois action_types; paginação; erro 4xx legível (`Meta Ads /insights falhou: <status> <corpo>`).
- [ ] Commit `feat: cliente Meta Ads (insights por campanha + série diária)`.

---

### Task 4: Captura de origem no pipeline inbound

**Files:** Modify `src/lib/whatsapp/inbound.ts` (NormalizedInboundMessage + persistInboundMessage), `src/app/api/whatsapp/webhook/route.ts` (Meta referral), `src/lib/whatsapp/uazapi-webhook.ts` (campo equivalente, tolerante), componente da conversa no inbox (badge); Test em `src/lib/marketing/site-ref.test.ts` + ajustes nos testes de webhook existentes.
**Produces:** `extractSiteRef(text: string): {ref: string | null; cleanText: string}` em `src/lib/marketing/site-ref.ts`; campos opcionais `adReferral?: object | null` em NormalizedInboundMessage; conversas ganham ad_referral/site_ref na PRIMEIRA mensagem.

- [ ] `extractSiteRef`: detecta `[ref:<slug>]` (slug `[\w-]{1,64}`), retorna ref + texto sem o marcador (trim de espaço duplo). TDD: com marcador, sem, marcador no meio, slug inválido ignorado, dois marcadores (usa o primeiro, remove todos).
- [ ] Pipeline (ADITIVO): em persistInboundMessage, quando a conversa é criada (convResult.created) e a mensagem tem adReferral ou site_ref detectado no contentText → UPDATE conversations set ad_referral/site_ref. O texto persistido/preview usa cleanText. fromMe nunca gera origem.
- [ ] Webhook Meta: mapear `message.referral` (quando presente) para normalized.adReferral ({source_id, headline, source_type, ...}). Uazapi: procurar campo de referral/ctwa no schema Message do spec OpenAPI (curl+jq); implementar tolerante (se ausente, null) com comentário para confirmação no E2E.
- [ ] Badge de origem no inbox: onde a conversa é exibida (header do thread), badge "Anúncio"/"Site"/nenhum — mínimo visual, mesmo padrão de badges existente; i18n pt/en.
- [ ] Suíte completa sem regressão + commit `feat: captura de origem das conversas (anúncio e site) no pipeline inbound`.

---

### Task 5: Rotas de integrações e summary

**Files:** Create `src/app/api/marketing/integrations/route.ts` (POST/DELETE), `src/app/api/marketing/summary/route.ts` (GET), `src/lib/marketing/attribution.ts`.
**Produces:**
- POST /api/marketing/integrations body `{platform: 'ga4'|'meta_ads', credentials: object, config: object}` → valida com chamada de teste real ao provedor (GA4: runReport de 1 dia; Meta: GET /act_{id} com fields=name) ANTES de gravar; encrypt(JSON.stringify(credentials)); upsert por (account, platform); 422 com mensagem da plataforma se a validação falhar. DELETE `{platform}` remove. GET → `[{platform, configured: true, config}]` (nunca credenciais).
- GET /api/marketing/summary?period=7d|30d|90d → `{period, ga4: Ga4Summary|null|{error}, metaAds: AdsSummary|null|{error}, attribution: AttributionSummary, previous: {ga4…, metaAds…} para deltas, fetchedAt}`; cache 1h por (account, platform, period) em marketing_cache (leitura fresh→serve; stale/ausente→fetch→upsert; erro de API com cache velho disponível → serve o velho + flag `stale: true`); período anterior calculado e cacheado igual (period sufixo '-prev').
- `attribution.ts`: `attributionSummary(db, accountId, period): Promise<AttributionSummary>` — queries em conversations (ad_referral/site_ref/created_at) + join deals por contact_id no período; % respondidas = conversas com ≥1 mensagem sender_type in ('agent','bot').
- [ ] Auth padrão getCurrentAccount; testes unitários para os helpers puros (cálculo de janela de período/prev, decisão de cache fresh/stale). Commit `feat: rotas de integrações e summary de marketing com cache`.

---

### Task 6: UI — credenciais + página /marketing

**Files:** Create `src/components/settings/marketing-integrations.tsx`, `src/app/(dashboard)/marketing/page.tsx` (+ componentes locais de card/tabela se o padrão do dashboard existente usar arquivos separados); Modify settings-sections (entrada "Integrações de Marketing"), sidebar (item "Marketing"), messages/en.json + pt.json.

- [ ] Tela de credenciais: um card por plataforma (GA4, Meta Ads; Google Ads como "em breve" desabilitado) com campos (GA4: textarea p/ JSON da service account + property ID; Meta: token + ad account ID), botão Salvar (POST valida e dá toast com o erro da plataforma se inválido), estado configurado com "Remover". NUNCA exibir credenciais salvas.
- [ ] Página /marketing: seletor 7/30/90d; 6 cartões de resumo com deltas; gráfico de linha (recharts, padrão do dashboard existente) investimento/leads/conversas por dia; tabela Meta Ads por campanha (métricas 10–18); seção GA4 (27–33, origem/mídia e top páginas em tabelas); seção Atribuição (34–36 + 38; 37 = tabela whatsappClicks do GA4 com empty-state explicando como configurar o evento); estados: sem integração → empty-state apontando para Configurações; erro por plataforma → card de erro com "reconfigurar" sem derrubar o resto; `stale: true` → aviso discreto "dados de <hora>".
- [ ] Item no sidebar gated: aparece se GET /api/marketing/integrations retorna ≥1 configurada (ou admin). i18n paridade. Build compila.
- [ ] Commit `feat: página de marketing e tela de integrações`.

---

### Task 7: Documentação + verificação de conjunto

- [ ] Create `docs/marketing.md`: como obter cada credencial (passo a passo GA4 service account + property ID; Meta system user token + ad account); snippet do botão do site (`https://wa.me/<numero>?text=Ol%C3%A1!%20Vim%20pelo%20site%20%5Bref%3Asite-home%5D`) com variações por página; passo a passo do evento GA4 `click_whatsapp` (gtag/GTM); limitações (atribuição só CTWA, lead pode apagar o texto).
- [ ] `npx vitest run && npm run typecheck && npm run lint && npm run build` limpos; diff de regressão: pipeline inbound aditivo (persistência atual inalterada quando não há referral/marcador).
- [ ] Roteiro E2E manual (com credenciais reais da Display4): colar credenciais, validar números vs painéis nativos, conversa de teste com [ref:] e badge, cache/stale. Commit final `feat: dashboard de marketing leva 1 completo`.

## Fora deste plano
Google Ads (leva 2); OAuth por usuário; sync em background; UTM/pixel; ROAS; export.
