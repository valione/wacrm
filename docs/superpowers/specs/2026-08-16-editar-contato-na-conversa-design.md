# Editar o contato de onde ele aparece

**Data:** 2026-08-16
**Status:** aprovado

## O problema

Para corrigir o nome de um contato — o caso mais comum, um contato que
chegou pelo WhatsApp e o CRM guardou só o telefone — o atendente precisa
sair da conversa, ir até a seção Contatos, achar a pessoa na lista, editar
e voltar. O nome está bem ali na tela, mas não é editável.

O mesmo vale para o funil: o negócio mostra o contato e não deixa ajustá-lo.

## O que vamos construir

Abrir o formulário de contato que já existe (`ContactForm`) a partir de
três pontos, sem sair da tela:

1. Painel lateral do contato no Inbox — ícone de lápis ao lado do nome
2. Cabeçalho da conversa — o nome vira botão
3. Modal do negócio no Pipeline — lápis ao lado do seletor de contato

Reusar o formulário em vez de criar edição em linha do nome: ele já trata
telefone duplicado, tags e o índice único da migração 022. Um segundo jeito
de editar contato no produto seria um segundo lugar para essas regras
divergirem.

## A armadilha que define a arquitetura

`ContactForm` sincroniza as tags assim: ao salvar, **apaga todas** as linhas
de `contact_tags` do contato e insere as que estão selecionadas
(`contact-form.tsx:181-197`). E popula `selectedTagIds` a partir da prop
`contactTags` num `useEffect` que depende de `[open, contact]` — não de
`contactTags`.

Consequência: se o formulário abrir antes de as tags do contato terem sido
carregadas, ele abre com nenhuma tag marcada, e salvar **apaga em silêncio
todas as tags daquele contato**. Nada falha, nada avisa.

Hoje isso não acontece porque o único consumidor é a página de Contatos,
que já tem as tags em mãos quando abre o formulário. Os três pontos novos
não têm.

Por isso o desenho central é um envelope, não três chamadas ao formulário.

## Componentes

### `src/components/contacts/contact-edit-dialog.tsx` (novo)

```
Props: contactId: string | null
       open: boolean
       onOpenChange: (open: boolean) => void
       onSaved: (contact: Contact) => void
```

Comportamento:

- Quando `open` vira `true` e há `contactId`, busca em paralelo o contato
  (`contacts`) e suas tags (`contact_tags`).
- **Só monta `<ContactForm open>` quando as duas respostas chegaram.** Essa
  é a guarda contra a perda de tags descrita acima.
- Enquanto carrega, não mostra nada (a busca é local e instantânea; um
  esqueleto piscando seria pior que a espera).
- Ao receber `onSaved()` do formulário, relê o contato e chama
  `onSaved(contatoAtualizado)` para cima. O formulário não devolve o
  registro salvo, e quem chamou precisa dele para atualizar a tela.
- Erro na leitura: toast e fecha. Não abre um formulário meia-boca.

### `src/lib/contacts/edit-dialog-state.ts` (novo)

```ts
isReadyToEdit(contact: Contact | null, tags: ContactTag[] | null): boolean
```

Retorna `true` só quando o contato existe **e** `tags` já é um array
(`null` = ainda carregando; `[]` = carregou e o contato não tem tags — são
estados diferentes e a distinção é o ponto todo).

Existe como função nomeada para que a regra tenha nome e teste, em vez de
virar uma condição solta dentro do JSX.

### `src/components/inbox/contact-sidebar.tsx` (modificar)

- Botão de lápis ao lado do nome, escondido quando `isViewer`.
- Nova prop `onContactSaved?: (contact: Contact) => void`, repassada da
  página do Inbox.

### `src/components/inbox/message-thread.tsx` (modificar)

- O `displayName` do cabeçalho vira botão quando o usuário não é `viewer`;
  para `viewer` continua texto.
- Mesma prop `onContactSaved`.

### `src/app/(dashboard)/inbox/page.tsx` (modificar)

- `handleContactSaved(updated)`: faz `setActiveContact(updated)` e substitui
  o `contact` embutido nas conversas da lista cujo `contact_id` bate.
- Sem refetch: o objeto atualizado já veio do envelope. O nome muda no
  cabeçalho, no painel e na lista de conversas ao mesmo tempo.

### `src/components/pipelines/deal-form.tsx` (modificar)

- Lápis ao lado do `<select>` de contato, habilitado só quando
  `contactId` está preenchido; escondido para `viewer`.
- Ao salvar, recarrega a lista de contatos para o seletor mostrar o nome
  novo.

## Permissão

Os gatilhos somem para `viewer`. Isso é conveniência visual — a barreira
real é a política `contacts_update`, que já exige
`is_account_member(account_id, 'agent')`. Um viewer que forçasse a
chamada receberia zero linhas afetadas.

## i18n

Uma chave nova por namespace já em uso, em `pt.json` e `en.json`:

- `Inbox.sidebar.editContact`
- `Inbox.messageThread.editContact`
- `Pipelines.form.editContact`

Português: "Editar contato". Inglês: "Edit contact".

## Testes

- `edit-dialog-state.test.ts` — os três estados (`null` carregando, `[]`
  carregado e vazio, contato ausente).
- Teste de regressão que lê o fonte de `contact-edit-dialog.tsx` e falha se
  `<ContactForm` aparecer fora da guarda `isReadyToEdit`. O risco real aqui
  não é a lógica estar errada hoje — é alguém remover a espera amanhã sem
  saber por que ela existia. Mesmo padrão usado para fixar o contrato de
  `onClick` do Base UI em `deal-pipeline-controls`.

O repositório não tem jsdom, então não há teste de renderização.

## Verificação manual (fumaça)

Contra uma instalação com dados reais, porque o risco é perda de tags:

1. Contato **com tags**, editar o nome pelo painel lateral → nome muda no
   cabeçalho, painel e lista; **as tags continuam lá**.
2. Editar pelo cabeçalho da conversa → mesmo resultado.
3. Editar pelo modal do negócio → nome novo aparece no seletor e no card.
4. Entrar como `viewer` → nenhum dos três gatilhos aparece.

O teste 1 é o que importa: é o único que verifica a armadilha.

## Fora de escopo

- Editar contato pela lista de conversas ou pelo card do funil. Ambos
  abrem a conversa/negócio em um clique, e o gatilho está lá dentro.
- Edição em linha do nome. Descartada acima.
- Migração de banco. Nenhuma é necessária.
