# Dashboard de Marketing — GA4, Meta Ads e Google Ads

**Data:** 2026-07-12
**Status:** aprovado para planejamento de implementação

## Objetivo

Nova página **Marketing** no menu lateral: dashboard com métricas de Google
Analytics 4, Meta Ads e Google Ads, mais atribuição de leads (anúncio →
conversa no WhatsApp). Modelo de uso: uma instalação por cliente, admin único
(decisão do dono do projeto); credenciais coladas uma vez pelo admin.

## Decisões aprovadas

1. **Credenciais (opção A):** tela Configurações → Integrações de Marketing;
   admin cola as credenciais das plataformas; armazenadas **criptografadas**
   (AES-256-GCM via `encrypt()` existente) em tabela nova
   `marketing_integrations` (uma linha por conta+plataforma). Sem OAuth de
   usuário final.
   - GA4: service account JSON (Google Analytics Data API) + property ID.
   - Meta Ads: access token de sistema (Marketing API) + ad account ID.
   - Google Ads: developer token + refresh token + customer ID — **segunda
     leva** (aprovação do developer token demora); o design já prevê o slot.
2. **Busca de dados (opção 1):** sob demanda com cache. Rotas server-side
   consultam as APIs quando o dashboard abre; resultado em cache por 1h
   (tabela `marketing_cache`: conta+plataforma+período → JSON + fetched_at).
   Sem sync em background nesta fase.
3. **Métricas:**
   - Cartões de resumo: investimento total, leads totais, CPL médio
     (consolidado Meta+Google Ads), sessões GA4.
   - GA4: sessões, usuários, taxa de engajamento, conversões, principais
     origens de tráfego (tabela).
   - Meta Ads e Google Ads: investimento, impressões, cliques, CTR,
     leads/conversões, CPL — **por campanha** (tabela).
   - Seletor de período: 7/30/90 dias, com comparação vs período anterior
     (deltas % nos cartões).
4. **Atribuição de leads (anúncio → conversa):**
   - Captura: anúncios "Clique para WhatsApp" da Meta entregam metadados de
     origem (referral: source_id/ad_id, headline) junto com a primeira
     mensagem. Migração adiciona `conversations.ad_referral JSONB` (nullable);
     o pipeline inbound grava quando o provedor entregar (Meta oficial:
     `message.referral`; Uazapi: campo equivalente no payload — confirmar
     nome exato no E2E e implementar tolerante).
   - Exibição: bloco "Leads por anúncio" no dashboard (conversas com
     ad_referral agrupadas por campanha/anúncio no período) + badge de origem
     na conversa do inbox. Conversas sem referral = "orgânico/direto".
   - Honestidade de escopo: atribuição cobre apenas cliques diretos
     anúncio→WhatsApp que as plataformas reportam; sem UTM/pixel nesta fase.

## Componentes

- **Migração 040:** `marketing_integrations` (account_id, platform CHECK
  ('ga4','meta_ads','google_ads'), credentials TEXT criptografado, config
  JSONB p/ ids não-secretos, UNIQUE(account_id, platform), RLS por conta),
  `marketing_cache` (chave conta+platform+period, payload JSONB, fetched_at),
  `conversations.ad_referral JSONB`.
- **Clientes de API** (`src/lib/marketing/ga4.ts`, `meta-ads.ts`,
  `google-ads.ts` na leva 2): fetch puro, sem SDKs pesados; GA4 via
  `runReport` da Data API com JWT da service account; Meta via Graph API
  `/insights`.
- **Rotas:** `GET /api/marketing/summary?period=30d` (orquestra: cache → APIs
  → normaliza para um shape único por plataforma), `POST/DELETE
  /api/marketing/integrations` (salvar/testar/remover credenciais; POST
  valida com uma chamada de teste antes de gravar).
- **UI:** página `/marketing` (cards + tabelas, gráfico de linha
  investimento/leads por dia usando o padrão de gráficos do dashboard
  existente — recharts já é dependência); tela de credenciais em
  Configurações; entrada "Marketing" no menu lateral com gate: aparece só
  quando há ≥1 integração configurada (ou para admin, com empty-state
  convidando a configurar).
- **Erros:** credencial inválida/expirada → card da plataforma mostra estado
  de erro com ação "reconfigurar" (sem derrubar as demais); rate limit →
  serve cache velho com aviso de última atualização.
- **i18n:** pt/en em paridade, como sempre.

## Testes

Unitários: normalizadores de resposta (fixture de payload de cada API →
shape único), montagem de JWT do GA4, cálculo de deltas de período, gate de
cache (1h). E2E manual: colar credenciais reais da Display4, validar números
contra os painéis nativos das plataformas.

## Fora de escopo (v1)

- Google Ads (leva 2, mesmo design); OAuth por usuário; sync em background /
  histórico longo; UTM/pixel; ROAS com receita; relatórios agendados/export.
