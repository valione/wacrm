# Suporte a segundo provedor de WhatsApp: WAHA (conexão via QR Code)

**Data:** 2026-07-10
**Status:** aprovado para planejamento de implementação

## Objetivo

Adicionar a WAHA (https://waha.devlike.pro — API não oficial do WhatsApp, protocolo
WhatsApp Web) como segundo provedor de conexão, ao lado da Meta Cloud API existente.
O usuário escolhe o provedor na tela Configurações → WhatsApp; a WAHA conecta por
QR Code escaneado com o celular. Nada do caminho Meta pode quebrar.

## Decisões de produto (aprovadas)

1. **Hospedagem da WAHA:** um servidor WAHA único para a instalação inteira,
   configurado por variáveis de ambiente (`WAHA_URL`, `WAHA_API_KEY`,
   `WAHA_WEBHOOK_SECRET`). Cada conta do CRM que escolher WAHA cria uma *sessão*
   nesse servidor. Sem as envs, a opção WAHA não aparece e o app se comporta
   exatamente como hoje.
2. **Escopo v1: cobertura completa adaptada.** Contas WAHA têm inbox
   (texto/mídia/áudio), automações, IA, fluxos e transmissões com **texto livre**
   (em vez de template). Elementos interativos (botões/listas) têm fallback de
   texto numerado. Aviso claro de risco de banimento em disparos em massa.
3. **Provedor exclusivo por conta:** mantém-se 1 config por conta
   (`UNIQUE(account_id)`). Trocar de provedor exige desconectar o atual;
   contatos, conversas e mensagens são preservados (pertencem à conta,
   não ao provedor).

## Arquitetura: camada de provedor (adapter)

Abordagem escolhida entre três avaliadas: interface de provedor com duas
implementações, sem unificar as três orquestrações de envio existentes
(refatoração pesada fica para depois; reduz risco de regressão no caminho Meta).

### Novo diretório `src/lib/whatsapp/providers/`

- `types.ts` — interface `WhatsAppProvider` (`sendText`, `sendMedia`,
  `sendTemplate`, `sendInteractive`, `downloadMedia`, `healthCheck`) e objeto
  `Capabilities` (`supportsTemplates`, `has24hWindow`, `supportsInteractive`, …).
- `meta.ts` — embrulho fino sobre `src/lib/whatsapp/meta-api.ts` (que permanece
  intocado).
- `waha.ts` — cliente HTTP novo para a WAHA (`POST /api/sendText`, sessões,
  QR, mídia etc.), autenticado por `WAHA_API_KEY`.
- `resolve.ts` — `resolveProvider(config)` → instância + capacidades, a partir
  de `whatsapp_config.provider`.

Os três call sites que hoje importam `meta-api.ts` diretamente —
`src/lib/whatsapp/send-message.ts`, `src/lib/automations/meta-send.ts`,
`src/lib/flows/meta-send.ts` — passam a despachar a última milha do envio pela
interface. A lógica deles de validação, persistência, retry e variantes de
telefone não muda. Operações exclusivas da Meta (registro de número com PIN,
subscribe de app, gestão de templates, upload resumível) **ficam fora** da
interface e continuam chamadas apenas no caminho Meta.

## Banco de dados — migração `037_whatsapp_provider.sql`

Na tabela `whatsapp_config`:

- `provider text NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta','waha'))`
  — linhas existentes continuam válidas sem alteração.
- `waha_session text UNIQUE` — nome da sessão no servidor WAHA, gerado como
  `wacrm_<account_id>`.
- `waha_phone text` — número vinculado após o QR (ex.: `5511999999999`).
- `phone_number_id` passa a ser nullable, com
  `CHECK (provider <> 'meta' OR phone_number_id IS NOT NULL)` — obrigatório
  para Meta como hoje, nulo para WAHA.

IDs de mensagem da WAHA são gravados na mesma coluna `messages.message_id`
que hoje guarda o `wamid` (ambos strings opacas; rastreio de status/reply/reação
já casa por igualdade).

## Tela Configurações → WhatsApp

Seletor no topo com dois cartões: **API Oficial da Meta** (formulário atual,
intocado) e **WAHA — conexão via QR Code**. Trocar de provedor com conexão
ativa exige desconectar antes, com aviso de que conversas/contatos são
preservados.

### Fluxo do QR Code

1. "Conectar via QR Code" → `POST /api/whatsapp/waha/session` cria/inicia a
   sessão `wacrm_<account_id>` na WAHA, já configurando nela o webhook de volta
   (URL do CRM, eventos `message`, `message.ack`, `session.status`, HMAC).
2. A tela exibe o QR via `GET /api/whatsapp/waha/session/qr` (proxy interno da
   imagem — a `WAHA_API_KEY` nunca chega ao navegador), renovando a imagem
   a cada ~20s.
3. Polling de status; quando a sessão vira `WORKING`, o CRM busca o número
   vinculado e grava a config (`provider='waha'`, `waha_session`, `waha_phone`,
   `status='connected'`). Tela mostra "Conectado como +55 …".
4. **Desconectar** = logout + remoção da sessão na WAHA + limpeza da config
   (equivalente ao Reset Configuration da Meta).

**Health check:** o `GET /api/whatsapp/config` atual, no caso WAHA, consulta o
status da sessão no servidor WAHA e distingue "servidor inacessível" de
"sessão desconectada".

## Recebimento — rota nova `/api/whatsapp/webhook/waha`

- Valida HMAC do corpo com `WAHA_WEBHOOK_SECRET` (fail-closed, espelhando o
  webhook da Meta).
- Resolve a conta pelo nome da sessão presente no evento.
- Traduz o payload WAHA para o formato interno e reusa o pipeline de
  persistência do webhook Meta (criar contato/conversa, gravar mensagem,
  disparar fluxos/automações/IA/webhooks públicos). Essa parte comum é
  extraída do webhook Meta atual para módulo compartilhado; a rota Meta
  mantém sua validação e parsing próprios.
- `message.ack` → escada de status existente (`pending→sent→delivered→read`),
  incluindo espelhamento em `broadcast_recipients`.
- `session.status` indicando queda → config marcada `disconnected` +
  notificação no sino ("Sua sessão do WhatsApp caiu — reconecte pelo QR Code").
- Mídia recebida: o CRM baixa do servidor WAHA e serve pelo proxy de mídia
  existente (navegador nunca fala com a WAHA).
- Mensagens `fromMe` (enviadas pelo celular, fora do CRM) são ingeridas como
  mensagens de agente, mantendo a conversa completa sem duplicação — inclui
  deduplicar o eco das mensagens que o próprio CRM enviou (casando por
  `message_id`).

## Comportamento por funcionalidade (gating por capacidades)

O `GET /api/whatsapp/config` retorna `provider` + `capabilities`; o frontend
adapta cada tela:

- **Inbox:** sem bloqueio de janela de 24h para WAHA (composer sempre livre).
  Meta inalterada.
- **Transmissões:** para WAHA, editor de texto livre + mídia opcional no lugar
  da escolha de template. Ritmo anti-banimento: intervalo aleatório entre
  destinatários (padrão ~5s, configurável por env) e aviso permanente de risco
  de bloqueio. Acompanhamento de status via eventos `ack`.
- **Templates (Configurações):** seção oculta para contas WAHA.
- **Automações e IA:** sem mudança funcional — o envio de texto sai pelo
  provedor resolvido.
- **Fluxos:** nós de botões/lista viram, na WAHA, mensagem numerada
  ("1️⃣ Opção A / 2️⃣ Opção B — responda com o número"); a resposta é casada por
  número ou texto da opção. O construtor exibe aviso nesses nós quando a conta
  é WAHA.

## Erros e resiliência

- WAHA fora do ar: envios de contas WAHA falham com mensagem clara; contas
  Meta não são afetadas.
- Sessão derrubada pelo celular: config `disconnected` + notificação; mensagens
  recebidas durante a queda são perdidas (limitação do protocolo, documentada
  na tela).
- Sem `WAHA_URL` no ambiente: opção WAHA oculta; comportamento idêntico ao
  atual.

## Testes

- Unitários (vitest): tradução payload WAHA→formato interno; mapeamento
  `ack`→status; fallback botões→texto numerado; gating de capacidades;
  verificação HMAC do webhook WAHA.
- Regressão Meta: suíte existente permanece válida (transporte Meta intocado).
- E2E manual: container local `devlikeapro/waha` — conectar QR, enviar/receber
  texto e mídia, transmissão com ritmo, queda e reconexão de sessão.

## Fora de escopo (v1)

- Multi-número por conta (modelo continua 1 config/conta).
- Unificação das três orquestrações de envio duplicadas (refatoração separada).
- Botões/listas nativos via WAHA (suporte instável no protocolo web).
- WAHA por conta (URL/chave individuais — cenário de revenda fica para depois).
