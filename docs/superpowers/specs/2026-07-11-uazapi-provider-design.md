# Terceiro provedor de WhatsApp: Uazapi (conexão via QR Code)

**Data:** 2026-07-11
**Status:** aprovado para planejamento de implementação
**Pré-requisito:** fase 1 da WAHA completa (spec `2026-07-10-waha-provider-design.md`)

## Objetivo

Adicionar a Uazapi (https://docs.uazapi.com — API não oficial de WhatsApp, serviço
hospedado na nuvem deles, uazapiGO v2.1.1) como terceiro provedor, ao lado da Meta
Cloud API e da WAHA. Conexão via QR Code na tela Configurações → WhatsApp, no mesmo
seletor de provedor existente. Nada dos caminhos Meta e WAHA pode quebrar.

## Decisões de produto (aprovadas)

1. **Modelo de acesso (opção A):** uma assinatura Uazapi para a instalação inteira.
   `UAZAPI_URL` e `UAZAPI_ADMIN_TOKEN` em variáveis de ambiente; quando uma conta
   do CRM escolhe Uazapi, o sistema cria automaticamente uma instância
   (`POST /instance/create`, header `admintoken`) e guarda o token da instância
   **criptografado** na coluna `access_token` (AES-256-GCM, mesmo mecanismo da Meta).
   O usuário ainda não tem assinatura: desenvolvimento e E2E validados contra o
   servidor demo `https://free.uazapi.com` (instâncias apagadas após 1h — suficiente
   para o ciclo de teste); o servidor real entra depois trocando as envs.
2. **Escopo v1 (opção A): paridade com a WAHA fase 1 + reações.** Inbox completo
   (texto/mídia, sem janela de 24h), automações, fluxos de texto, sem templates,
   **reações ligadas** (`POST /message/react` da Uazapi; `supportsReactions: true`).
   Botões/listas nativos da Uazapi ficam para a fase 3 do roadmap (interativos nos
   fluxos), quando cada provedor recebe conforme sua capacidade: Uazapi botões
   nativos, WAHA fallback numerado. Transmissões ficam na fase 2, junto com a WAHA.
3. **Provedor exclusivo por conta** (regra existente): 1 config por conta; trocar
   exige desconectar; conversas/contatos preservados.

## Banco de dados — migração `038_provider_generalization.sql` (opção 1 aprovada)

- Renomeia `whatsapp_config.waha_session` → `provider_session` e
  `waha_phone` → `provider_phone` (o índice único parcial acompanha). Ajuste
  mecânico das referências no código WAHA (~6 arquivos: rotas de sessão, webhook
  WAHA, config route, tipos).
- `provider` CHECK passa a `IN ('meta', 'waha', 'uazapi')`.
- Semântica por provedor: WAHA usa `provider_session` = nome da sessão;
  Uazapi usa `provider_session` = **id da instância** e `access_token` =
  **token da instância criptografado** (a WAHA continua com o sentinela `'waha'`).
- `provider_phone` = número vinculado (ambos).

## Ambiente

`UAZAPI_URL`, `UAZAPI_ADMIN_TOKEN`, `UAZAPI_WEBHOOK_SECRET` — os três obrigatórios
para a opção aparecer (`uazapiEnabled()`, mesma regra da WAHA). Sem eles,
comportamento idêntico ao atual.

## Cliente HTTP — `src/lib/whatsapp/uazapi-api.ts`

Espelha o papel do `waha-api.ts`. Funções (paths do spec OpenAPI oficial):

- `createInstance({name})` — `POST /instance/create`, header `admintoken`;
  retorna `{token, instance}`. Nome determinístico `wacrm_<account_id>`.
- `connectInstance({token})` — `POST /instance/connect` body `{}` (QR; timeout 2min).
- `getInstanceStatus({token})` — `GET /instance/status`; retorna
  `{status: 'disconnected'|'connecting'|'connected'|'hibernated', qrcode?: string
  (base64), phone?: string (de status.jid.user), loggedIn: boolean}`. O polling
  neste endpoint renova o QR.
- `disconnectInstance({token})` — `POST /instance/disconnect`.
- `deleteInstance({token})` — `DELETE /instance` (token da instância, não admin).
- `setInstanceWebhook({token, url})` — `POST /webhook` com
  `{url, events: ['messages','messages_update','connection'],
  excludeMessages: ['wasSentByApi']}` — o filtro `wasSentByApi` evita eco do que o
  próprio CRM envia (resolvido na origem; não precisa do retry de 3s da WAHA).
- `uazapiSendText({token, number, text, replyid?})` — `POST /send/text`;
  retorna `{messageId}` (campo `messageid` da resposta — o wamid-like).
- `uazapiSendMedia({token, number, kind, url, caption?, docName?})` —
  `POST /send/media`, `file` = URL pública. Mapeamento do `kind` do CRM para o
  `type` da Uazapi: `image`→`image`; `video`→`video`; `document`→`document`
  (+ `docName`); `audio`→`ptt` (nota de voz, espelhando o comportamento
  do WhatsApp para áudio gravado no inbox).
- `uazapiSendReaction({token, number, messageId, emoji})` — `POST /message/react`
  body `{number, text: emoji (vazio remove), id: messageId}`.
- Auth: header `token` (instância) em tudo, exceto `createInstance` (`admintoken`).
- Sem `UAZAPI_URL`, nenhuma função lança na importação — só na chamada.

## Camada de provedores

- `providers/uazapi.ts`: implementa `WhatsAppProvider` (sendText/sendMedia) com o
  token descriptografado + `provider_session`. Capacidades:
  `{supportsTemplates: false, has24hWindow: false, supportsInteractive: false,
  supportsReactions: true}`.
- `resolve.ts` ganha o ramo `'uazapi'` (exige `provider_session` e accessToken
  descriptografado — diferente da WAHA, o token aqui é real e criptografado).
- `CAPABILITIES` ganha a entrada `uazapi`.
- A rota de reação (`react/route.ts`) troca a guarda `provider === 'waha'` por
  checagem de capacidade (`!capabilities.supportsReactions` → 422) e, no ramo
  suportado não-Meta, despacha para `uazapiSendReaction`. Meta intocada. O gating
  de UI da reação (Task 12 da WAHA) já é por capacidade — funciona sozinho.

## Fluxo de conexão (tela de Configurações)

Terceiro cartão no seletor: **"Uazapi — QR Code"** (só aparece com
`uazapi_available === true` no GET do config). Painel espelha o da WAHA:

1. "Conectar via QR Code" → `POST /api/whatsapp/uazapi/instance`: cria a instância
   na Uazapi (se a conta ainda não tem), grava config
   (`provider='uazapi'`, `provider_session`=id, `access_token`=token criptografado,
   `status='disconnected'`), registra o webhook da instância
   (URL: `${NEXT_PUBLIC_SITE_URL}/api/whatsapp/webhook/uazapi?s=<UAZAPI_WEBHOOK_SECRET>`)
   e chama `connectInstance`.
2. Painel exibe o QR: `GET /api/whatsapp/uazapi/instance` faz polling do status e
   retorna `{status, qrcode, phone}` — o QR chega como **data URL base64 no JSON**
   (diferente da WAHA, que serve PNG binário; o componente usa `<img src={dataUrl}>`).
3. Status `connected` + `loggedIn` → atualiza config (`provider_phone`,
   `status='connected'`, `connected_at`) e mostra "Conectado como +55…".
4. **Desconectar** → `DELETE /api/whatsapp/uazapi/instance`: desconecta E deleta a
   instância na Uazapi (best-effort) + apaga a linha de config.
5. Instância órfã/expirada (caso demo de 1h ou instância deletada no painel Uazapi):
   erros 401/404 do status → tratar como desconectado com mensagem clara; o
   "Conectar" recria a instância do zero (o create é idempotente por nome? NÃO
   assumir — se o create duplicar, deletar a antiga pelo token salvo antes de criar).

**Health check:** ramo `uazapi` no `GET /api/whatsapp/config` — consulta
`getInstanceStatus`; distingue "servidor Uazapi inacessível" de "instância
desconectada" (mesmo padrão WAHA).

## Recebimento — rota `/api/whatsapp/webhook/uazapi`

A Uazapi **não assina webhooks** (confirmado no spec: sem HMAC/secret). Proteção:

- O segredo vai na própria URL registrada (`?s=<UAZAPI_WEBHOOK_SECRET>`);
  a rota compara em tempo constante e responde 401 sem ele. Fail-closed: sem a env,
  501. (Consequência documentada: o segredo aparece nos logs de acesso do CRM —
  aceitável; rotacionável trocando a env e re-registrando o webhook.)
- Payload `{event, instance, data}`; resolve a conta por `instance` (id) =
  `provider_session` com `provider='uazapi'`; desconhecida → descarta.
- `event='messages'` → normaliza `data` (schema Message) para
  `NormalizedInboundMessage` → `persistInboundMessage` (pipeline compartilhado).
  Campos: `externalId`=`messageid`, telefone do `chatid`/`sender` (sufixos
  `@s.whatsapp.net`), `fromMe` do payload (com `excludeMessages: ['wasSentByApi']`,
  os fromMe que chegam são só os digitados no celular — exatamente o eco desejado),
  grupos (`@g.us`) descartados, mídia baixada/proxiada (ver abaixo),
  `timestamp` de `messageTimestamp` (ms).
- `event='messages_update'` → mapeia `status` (`Sent|Delivered|Read|Failed`) para a
  escada existente via `applyStatusByExternalId`.
- `event='connection'` → `disconnected`/`hibernated` marca config desconectada +
  notificação no sino (`whatsapp_disconnected`, já existe); `connected` marca
  conectada.
- Processamento dentro de `after()` (ACK rápido), padrão dos outros dois webhooks.
- **Mídia inbound:** o `data` de mensagens de mídia traz URL de arquivo hospedado
  na Uazapi (ou conteúdo base64 — confirmar payload real no E2E; o spec não traz
  exemplos completos). Estratégia: proxy autenticado
  `/api/whatsapp/uazapi/media?src=…` com validação de host `UAZAPI_URL` + checagem
  de que o `src` corresponde a `messages.media_url` da conta (RLS), espelhando o
  proxy WAHA pós-fix. Se o payload real vier base64, ajustar no plano (gravar via
  storage ou data URL — decisão adiada para o E2E do plano, documentada lá).

## Erros e resiliência

- Servidor Uazapi fora: envios falham com mensagem clara; Meta e WAHA intocados;
  health check distingue servidor vs instância.
- Token de instância corrompido (ENCRYPTION_KEY trocada): mesmo tratamento
  `token_corrupted` da Meta (reset + reconectar).
- 429 do servidor (máximo de instâncias): mensagem específica na criação
  ("servidor Uazapi lotado — verifique seu plano").
- Sem as 3 envs: opção oculta, comportamento idêntico ao atual.

## Testes

- Unitários (vitest): cliente uazapi-api (mock fetch, headers admintoken/token),
  normalização payload Uazapi→NormalizedInboundMessage, mapeamento
  `messages_update`→escada, segredo da URL do webhook (timing-safe), capacidades.
- Regressão: suíte completa sem falhas novas (Meta e WAHA intocados fora do rename
  mecânico das colunas).
- E2E contra `free.uazapi.com`: conectar QR, enviar/receber texto e mídia, reação,
  eco fromMe (digitado no celular), queda de sessão (instância demo expira em 1h —
  útil para testar a notificação de queda de graça).

## Fora de escopo (v1)

- Botões/listas nativos (fase 3 do roadmap — Uazapi receberá botões nativos).
- Transmissões (fase 2, junto com WAHA).
- Grupos, canais/newsletter, campanhas (`/sender/*`), CRM embutido da Uazapi,
  paircode (só QR na v1), SSE (só webhook).
- Multi-instância por conta; webhook global (`/globalwebhook`).
