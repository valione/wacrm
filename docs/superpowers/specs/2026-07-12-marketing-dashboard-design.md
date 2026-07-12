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
3. **Métricas — lista fechada (aprovada pelo dono do projeto):**
   - *Cartões de resumo (deltas % vs período anterior):* (1) investimento
     total Meta+Google Ads; (2) leads totais de anúncio; (3) CPL médio
     consolidado; (4) sessões GA4; (5) conversas WhatsApp iniciadas no
     período; (6) conversas vindas de anúncio.
   - *Gráfico principal (linha, por dia):* (7) investimento por dia;
     (8) leads por dia; (9) conversas WhatsApp criadas por dia (sobreposto).
   - *Meta Ads, tabela por campanha + totais + badge de status:*
     (10) investimento; (11) impressões; (12) alcance; (13) cliques;
     (14) CTR; (15) CPC; (16) leads/resultados; (17) CPL; (18) frequência.
   - *Google Ads (leva 2), espelho da Meta:* (19–25) investimento,
     impressões, cliques, CTR, CPC, conversões, CPA; (26) parcela de
     impressão.
   - *GA4:* (27) sessões; (28) usuários totais e novos; (29) taxa de
     engajamento; (30) duração média da sessão; (31) conversões
     (eventos-chave); (32) tabela origem/mídia com sessões e conversões;
     (33) top 10 páginas.
   - *Atribuição (dados do CRM):* (34) conversas por origem — três fatias:
     Anúncio / Site / Direto-outros; (35) tabela por anúncio/campanha de
     origem: conversas geradas, % respondidas, negócios criados no pipeline
     (join com `deals`); (36) custo por conversa iniciada (investimento ÷
     conversas atribuídas); (37) cliques no botão WhatsApp do site por
     origem da sessão (GA4, evento `click_whatsapp` ou equivalente
     configurado no site); (38) conversas com origem Site, por página de
     entrada (marcador).
   - Seletor de período global: 7/30/90 dias, comparação vs anterior.
4. **Atribuição de origem das conversas (três mecanismos):**
   - **Anúncio:** anúncios "Clique para WhatsApp" entregam metadados de
     origem (referral: source_id/ad_id, headline) na primeira mensagem.
     Migração adiciona `conversations.ad_referral JSONB` (nullable); o
     pipeline inbound grava quando o provedor entregar (Meta oficial:
     `message.referral`; Uazapi: campo equivalente no payload — confirmar
     nome exato no E2E e implementar tolerante).
   - **Site (marcador):** o botão de WhatsApp do site usa
     `wa.me/<numero>?text=...%20[ref:<pagina>]`. O pipeline inbound detecta
     `[ref:...]` na PRIMEIRA mensagem da conversa, grava
     `conversations.site_ref TEXT` (ex.: `site-home`) e remove o código do
     texto exibido/persistido. O projeto entrega o snippet do botão e o
     passo a passo do evento GA4 na documentação (docs/marketing.md).
     Limitação aceita: lead que apaga o texto pré-preenchido cai em
     Direto-outros.
   - **Direto-outros:** sem referral e sem marcador.
   - Badge de origem na conversa do inbox (Anúncio/Site/Direto).
   - Honestidade de escopo: sem UTM/pixel nesta fase; campanhas de tráfego
     para site aparecem com investimento porém sem conversas atribuídas —
     a UI sinaliza isso explicitamente para não parecer campanha "ruim".

## Componentes

- **Migração 040:** `marketing_integrations` (account_id, platform CHECK
  ('ga4','meta_ads','google_ads'), credentials TEXT criptografado, config
  JSONB p/ ids não-secretos, UNIQUE(account_id, platform), RLS por conta),
  `marketing_cache` (chave conta+platform+period, payload JSONB, fetched_at),
  `conversations.ad_referral JSONB` e `conversations.site_ref TEXT`.
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
