# Mudar a fase do pipeline pela Caixa de Entrada — Design

**Data:** 2026-08-15 · **Status:** aprovado no brainstorm (Miguel)

## Problema

Quem atende no Inbox vê o funil, mas não age sobre ele. A barra lateral do
contato (`src/components/inbox/contact-sidebar.tsx`) já lista os deals com o
nome e a cor da fase, porém só de leitura: para mover um card o atendente
precisa sair da conversa e abrir o board. Na prática a fase envelhece — o
atendente qualifica alguém na conversa e o funil não reflete isso.

## O que já existe (e será reusado)

- A barra lateral já carrega os deals do contato com a fase embutida:
  `select("*, stage:pipeline_stages(*)")` filtrando por `contact_id`
  (linhas 46-63). O seletor de fase entra sobre dados que já estão em mãos.
- `pipeline_stages` tem `pipeline_id`, `name`, `position` e `color` — dá para
  agrupar por funil e ordenar por `position` sem nenhuma coluna nova.
- RLS de `deals` (migração 017): `deals_insert` e `deals_update` exigem
  `is_account_member(account_id, 'agent')`. Viewer já é barrado no banco.
- `use-auth` expõe `isViewer` e `accountId` — a interface só precisa
  respeitar o que a RLS já garante.
- `accounts.default_currency` (migração 021) é a moeda de deals novos.

## Decisões do brainstorm

1. **Mover é por deal, criar é ação separada.** Cada deal listado ganha o
   próprio seletor, limitado às fases do funil dele. A criação fica numa ação
   distinta abaixo da lista. Alternativa descartada: um seletor único que
   move ou cria conforme o caso — um clique errado geraria card novo.
2. **A fase escolhida determina o funil.** No menu de criação as fases vêm
   agrupadas por funil, então não existe conceito de "funil padrão" a
   inventar (`pipelines` não tem `is_default`, e não vamos adicionar).
3. **Deal novo nasce mínimo.** Título = nome do contato, ou o telefone quando
   não há nome. Valor zero, moeda da conta. Refinar valor e título é trabalho
   do board.

## Escopo

### 1. Seletor de fase por deal

- Em cada deal já listado, abaixo do título, um seletor com as fases do
  funil daquele deal (`pipeline_id` do próprio deal), ordenadas por
  `position`. Mantém a cor da fase como hoje.
- Escolher uma fase faz `UPDATE deals SET stage_id` para aquele `id`.
- Atualização otimista: a interface muda na hora; se a escrita falhar, o
  estado anterior volta e um aviso aparece.
- Escolher a fase em que o deal já está não dispara escrita.

### 2. Ação "Adicionar a um funil"

- Abaixo da lista de deals, uma ação separada abre um menu com **todas** as
  fases da conta agrupadas por funil (funil como cabeçalho, fases ordenadas
  por `position`).
- Escolher uma fase insere em `deals`:
  - `pipeline_id` e `stage_id` — da fase escolhida
  - `contact_id` — o contato aberto
  - `conversation_id` — a conversa aberta (ver §3)
  - `title` — `contact.name` ou, se vazio, `contact.phone`
  - `value` — `0`
  - `currency` — `accounts.default_currency`
  - `account_id` — o da sessão
  - `user_id` — o usuário da sessão. **Obrigatório:** a coluna vem da
    migração 001 como `NOT NULL` e a 017 apenas acrescentou `account_id`
    ao lado dela; omitir derruba o insert.
  - `status` — `"open"`, o mesmo literal que `deal-form.tsx:200` grava. A
    coluna tem `DEFAULT 'active'`, divergência herdada do upstream; o board
    não filtra por status, mas seguir o formulário evita cards com valor
    diferente dos demais.
- Conta sem nenhum funil cadastrado: a ação não aparece (não há fase para
  escolher).
- O deal criado entra na lista sem recarregar a página.

### 3. Mudança de interface: a conversa precisa chegar à barra lateral

`ContactSidebarProps` hoje é `{ contact: Contact | null }`. Para gravar
`conversation_id` no deal criado, passa a ser
`{ contact: Contact | null; conversationId?: string }`, e quem renderiza a
barra no Inbox passa o id da conversa aberta. O campo é opcional: sem ele o
deal nasce sem conversa vinculada, em vez de falhar.

### 4. Permissões

- `isViewer === true` esconde o seletor e a ação de adicionar. A lista
  continua como é hoje, só de leitura.
- Nenhuma verificação nova no servidor: as políticas de `deals` da migração
  017 já são a barreira real.

## Dados

Nenhuma migração. `deals` e `pipeline_stages` têm tudo o que é preciso.

As escritas saem do cliente Supabase, seguindo o padrão que a própria barra
lateral já usa para ler e para gravar notas.

O board já faz exatamente o mesmo movimento em
`src/app/(dashboard)/pipelines/page.tsx:224` —
`update({ stage_id: newStageId }).eq("id", dealId)`, com `toast.error` e
recarga em caso de falha. O seletor da barra lateral repete esse padrão;
avisos usam `sonner`, como no resto do app.

## Erros e casos de contorno

| Situação | Comportamento |
|---|---|
| Falha ao mover | Reverte para a fase anterior + aviso |
| Falha ao criar | Deal não entra na lista + aviso |
| Conta sem funis | Ação de adicionar não aparece |
| Contato sem nome | Título do deal = telefone |
| Fase igual à atual | Nenhuma escrita |
| Papel viewer | Nenhum controle visível |

## Testes

- Teste unitário da função pura que agrupa fases por funil e ordena por
  `position` — inclui funil sem fases e ordenação com `position` repetido.
- O restante é interface, verificada no app rodando junto com o Miguel:
  mover um deal, criar um deal a partir da conversa, e conferir no board que
  o card aparece na fase certa com a conversa vinculada.

## Fora de escopo (de propósito)

- Editar valor, título ou moeda pelo Inbox — isso é o board.
- Histórico de movimentação de fase (não existe tabela para isso hoje).
- **Disparar automações ao mudar de fase.** Não existe gatilho `stage_changed`
  no motor de automações; criá-lo é projeto à parte. Mover a fase pelo Inbox
  não vai disparar nada.
- Arrastar e soltar no Inbox.
- Atualização em tempo real entre abas.
