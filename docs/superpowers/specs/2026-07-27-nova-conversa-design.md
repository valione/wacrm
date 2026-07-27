# Nova conversa com mensagem livre (provedores QR) — Design

**Data:** 2026-07-27 · **Status:** aprovado no brainstorm (Miguel)

## Problema

Hoje só é possível INICIAR uma conversa (contato sem thread aberta) pelo
"Enviar template" da ficha do contato — regra herdada da API oficial da
Meta (janela de 24h + templates aprovados). Os provedores QR (Uazapi e
WAHA) não têm essa limitação: podem mandar texto livre para qualquer
número. Falta a interface para isso.

## O que já existe (e será reusado)

- `POST /api/whatsapp/send` aceita `contact_id` sem `conversation_id` e
  **find-or-creates** a conversa (`findOrCreateConversation`). Nenhuma
  mudança de contrato é necessária.
- `CAPABILITIES` por provedor (`src/lib/whatsapp/providers/types.ts`):
  `has24hWindow: false` para waha/uazapi é o sinal de que texto livre
  pode iniciar conversa. O GET `/api/whatsapp/config` já devolve
  `capabilities` ao cliente.
- Normalização/dedup de telefone: `src/lib/contacts/dedupe.ts`
  (`normalizeKey`, `isExactMatch`, `isUniqueViolation`) e
  `src/lib/whatsapp/phone-utils.ts` — a criação de contato do modal usa
  os mesmos helpers do fluxo de contatos existente.

## Escopo

### 1. Inbox — botão "Nova conversa"

- Ícone `+` no cabeçalho da lista de conversas (ao lado da busca).
- Visível apenas quando `capabilities.has24hWindow === false` (ou seja,
  provedor conectado é waha/uazapi). Conta Meta não vê o botão.
- Abre modal com:
  - **Busca de contato** (autocomplete por nome/telefone nos contatos da
    conta) — selecionar preenche o destinatário; **ou**
  - **Número novo** (com DDI/DDD; placeholder `5511999998888`) + campo
    **nome (opcional)**. Se o número normalizado não existir em
    `contacts`, cria o contato na hora (mesma normalização/dedup do
    módulo de contatos; se já existir, reusa o existente — nunca nasce
    duplicata).
  - **Textarea** da primeira mensagem (obrigatória, texto puro).
  - Aviso discreto (texto pequeno, cor muted): "Mensagens frias em
    volume podem gerar restrição do número no WhatsApp."
- Enviar → `POST /api/whatsapp/send` com `contact_id` +
  `message_type: 'text'` + `content_text` → sucesso: fecha modal e abre
  a conversa criada, selecionada no Inbox.
- Erro do provedor (número inexistente no WhatsApp, instância caída):
  toast com a mensagem da rota; o modal permanece aberto para corrigir.
  (A rota valida payload ANTES de criar conversa, então não fica
  conversa órfã em erro de validação; erro de envio após criação deixa
  a conversa com a mensagem em `failed` — comportamento padrão atual do
  Inbox, aceitável.)

### 2. Ficha do contato — botão "Enviar mensagem"

- Ao lado do "Enviar template" existente em `contact-detail-view.tsx`.
- Mesma regra de visibilidade (`has24hWindow === false`).
- Mini-diálogo com textarea → mesmo POST → toast de sucesso com ação
  "Abrir no Inbox" (link para a conversa).

### 3. Gating e i18n

- Capacidades chegam do GET `/api/whatsapp/config` (já exposto); o
  Inbox e a ficha do contato passam a consultar/receber esse dado.
- Novas chaves em `messages/pt.json` e `messages/en.json` (produto é
  bilíngue; pt é o locale das instalações atuais).

## Fora de escopo

- Envio de mídia na primeira mensagem (dá para anexar depois, na
  conversa aberta).
- Iniciar conversa livre em contas Meta (limitação da plataforma;
  segue via template).
- Qualquer ferramenta de prospecção em massa (transmissões já cobrem
  listas; o objetivo aqui é o 1:1).

## Testes

- Unitários: helper de visibilidade por capacidade; reuso dos helpers
  de dedup no caminho "número novo" (caso número já existente → reusa
  contato; número novo → cria).
- E2E manual na instalação Campos Salles (Uazapi): iniciar conversa
  com número virgem pelo Inbox; iniciar pela ficha do contato; conta
  Meta (simulada localmente) não exibe os botões.

## Riscos

- Uso irresponsável (spam 1:1) pode restringir o número — mitigado
  pelo aviso no modal e por ser envio manual um-a-um.
- Divergência de formato de número → mitigada pela normalização única
  compartilhada com o módulo de contatos.
