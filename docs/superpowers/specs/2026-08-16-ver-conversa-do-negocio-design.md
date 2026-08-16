# Ver a conversa a partir do negócio — Design

**Data:** 2026-08-16 · **Status:** aprovado no brainstorm (Miguel)

## Problema

No board do funil, abrir um negócio mostra um link **"Vincular a uma
Conversa"** que não vincula nada e não leva a conversa nenhuma:

- O rótulo promete uma ação de vinculação que **nunca foi implementada** —
  o `payload` de `handleSave` (`deal-form.tsx:160-169`) não inclui
  `conversation_id`, nem na criação nem na edição.
- O destino é `<Link href="/inbox">` (`deal-form.tsx:288`) — cai na caixa
  de entrada genérica, sem abrir a thread.
- A conversa que ele detecta é a **mais recente do contato**
  (`deal-form.tsx:139-145`), ignorando o `conversation_id` que o próprio
  negócio guarda.

Resultado: negócio criado pelo board fica com `conversation_id` nulo para
sempre, e quem quer ir do funil para o atendimento tem que procurar a
conversa na mão.

## O que já existe (e será reusado)

- **Deep-link do Inbox**: `/inbox?c=<id>` já funciona e é usado por
  `notifications/page.tsx:119` e `dashboard/queries.ts:323`. Nenhuma
  navegação nova a construir.
- O `useEffect` que detecta a conversa do contato (`deal-form.tsx:131-151`)
  — aproveitado como está.
- `deals.conversation_id` já existe desde a migração 001. **Sem migração.**
- Desde a v1.9, negócios criados pelo Inbox já nascem com o vínculo
  correto (a conversa aberta na hora).

## Decisões do brainstorm

1. **Corrigir o controle existente, não somar um botão novo** ao lado de um
   quebrado.
2. **Gravar o vínculo ao salvar** (opção B). O formulário passa a persistir
   `conversation_id`, então o negócio criado pelo board fica vinculado de
   verdade.
3. **Vínculo existente manda.** Ver "Regra de resolução" abaixo.
4. Miguel ciente de que, com a v1.10, **apagar a conversa apaga os negócios
   vinculados** — logo, negócios do board passam a morrer junto com a
   conversa, o que hoje não acontece por não terem vínculo.

## Regra de resolução (o risco que motiva a função pura)

Sem regra explícita, editar um negócio já vinculado à conversa A — só para
mudar o valor — regravaria o vínculo para a conversa B, a mais recente do
contato. A origem da oportunidade se perderia em silêncio.

```
resolveDealConversationId(existing, detected):
  existing ?? detected ?? null
```

- Negócio com vínculo → **preserva**, em qualquer edição.
- Negócio sem vínculo → usa a conversa detectada pelo contato.
- Nenhuma das duas → grava `null`.

## Escopo

### 1. Helper puro

`src/lib/deals/resolve-conversation.ts`:
`resolveDealConversationId(existing: string | null | undefined, detected: string | null | undefined): string | null`

Trata `undefined` e string vazia como ausência.

### 2. Botão "Ver conversa"

- Rótulo novo: `Pipelines.form.viewConversation` — "Ver conversa" / "View
  conversation". A chave `linkToConversation` deixa de ser usada e é
  removida dos dois arquivos de mensagem.
- `href={`/inbox?c=${id}`}`, onde `id` é o resultado da regra de resolução.
- Aparece quando há um id; sem conversa alguma, não renderiza (igual hoje).
- Ícone `MessageSquare` e estilo mantidos.

### 3. Persistir o vínculo

`handleSave` passa a incluir no `payload`:

```
conversation_id: resolveDealConversationId(deal?.conversation_id, linkedConversation?.id)
```

Vale para criação e edição — na edição, a regra garante que um vínculo
existente nunca é trocado.

## Erros e casos de contorno

| Situação | Comportamento |
|---|---|
| Negócio vinculado à conversa A, contato tem B mais recente | Botão e gravação usam **A** |
| Negócio sem vínculo, contato tem conversa | Usa a detectada e passa a gravá-la |
| Contato sem conversa nenhuma | Botão não aparece; grava `null` |
| Conversa vinculada foi apagada | `conversation_id` já é `NULL` (a v1.10 apaga o negócio junto, então o caso é raro); cai no fallback do contato |

## Testes

- Unitários de `resolveDealConversationId`: preserva o existente; usa o
  detectado quando não há existente; devolve `null` sem nenhum dos dois;
  trata `undefined` e string vazia como ausência.
- Verificação manual: criar negócio pelo board para contato com conversa e
  conferir que nasce vinculado; clicar em "Ver conversa" e confirmar que
  abre a thread certa; editar o valor de um negócio vinculado e conferir
  que o vínculo não mudou.

## Fora de escopo (de propósito)

- Escolher a conversa numa lista.
- Desvincular pelo formulário.
- Vincular retroativamente os negócios antigos.
- Mostrar o botão no card do board (fica só no formulário aberto).
