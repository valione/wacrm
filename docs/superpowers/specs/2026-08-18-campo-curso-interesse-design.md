# Campo "Curso de interesse" nas instalações de educação

**Data:** 2026-08-18
**Status:** aprovado por Miguel, pronto para plano de implementação

## Problema

O contato do CRM tem um campo **Empresa**, herdado do produto original (feito para B2B).
Nas instalações de educação — Faculdades Campos Salles e Anhembi Morumbi hoje, outras
instituições depois — o dado que a secretaria precisa guardar não é a empresa do contato,
é o **curso que ele quer fazer**. Hoje o atendente vê "Empresa" e digita um curso ali,
ou simplesmente não usa o campo.

A Display4 (instalação nº 1, videowall corporativo) continua sendo B2B e deve manter
"Empresa" exatamente como está.

## Decisões tomadas

- **Preset de vertical, não rótulo livre.** Uma chave liga um conjunto de textos revistos
  à mão. Descartado deixar o admin digitar o rótulo, porque nem todo texto é a palavra
  isolada: o filtro do Inbox diz "Todas as empresas", e derivar "Todos os Curso de
  interesse" de uma única string daria português errado (gênero e plural).
- **Texto livre, não lista de cursos.** Miguel optou por manter digitação livre. O custo
  aceito e registrado: o filtro do Inbox agrupa por igualdade exata, então "ADM",
  "Administração" e "administracao" aparecem como três cursos distintos. Uma lista fechada
  fica para depois, se o filtro incomodar na prática.
- **Só o rótulo neste escopo.** Fluxos e automações que coletam o dado são conteúdo do
  banco de cada instalação, ajustados por Miguel na própria interface quando montar o
  funil de cada instituição. Não entram neste trabalho.
- **O exemplo dentro do campo é por instituição**, não pelo preset: Campos Salles usa
  `Direito`, Anhembi Morumbi usa `Publicidade e Propaganda`.
- **Sem migração de banco.** A coluna continua `contacts.company`. O nome é interno e
  nunca aparece para o usuário; renomeá-la custaria migração nos dois bancos e divergência
  permanente do upstream, sem ganho visível.

## Arquitetura

### Ponto único de troca

`src/i18n/request.ts` é o único lugar onde o dicionário de textos é carregado. O layout
chama `getMessages()`, que lê essa mesma configuração, e repassa o resultado ao
`NextIntlClientProvider` — logo, um patch aplicado ali alcança componentes de servidor e
de navegador de uma vez só.

Seis componentes exibem o rótulo hoje (`contacts/page.tsx`, `contact-form.tsx`,
`contact-detail-view.tsx`, `conversation-list.tsx`, `automation-builder.tsx`,
`node-config-form.tsx`) e **nenhum deles é editado**.

O motivo principal não é o volume — seis arquivos seriam editáveis à mão. É que o texto
precisa **variar por instalação a partir do mesmo código**: as três instalações compilam
do mesmo produto, então o rótulo não pode estar escrito dentro do componente. Ele tem que
vir de configuração, e o carregamento do dicionário é onde a configuração entra uma vez
só. O ganho secundário é o merge com o upstream (ArnasDon/wacrm) seguir sem conflito
nesses seis arquivos.

### Peças novas

1. **`src/lib/vertical.ts`** (novo) — expõe a vertical ativa e a tabela de substituições
   por locale. Função pura, sem I/O, testável isoladamente:
   - `VERTICAL`: lê `NEXT_PUBLIC_VERTICAL` (`''` = padrão, `'educacao'`).
   - `applyVerticalLabels(messages, locale)`: devolve uma cópia com as chaves trocadas.
     Com vertical vazia, devolve o objeto recebido **inalterado**.
   - O exemplo do campo vem de `NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE`; se vazio, cai no
     padrão do preset (`Administração`).

2. **`src/i18n/request.ts`** (editado) — passa `messages` por `applyVerticalLabels` antes
   de retornar. Poucas linhas.

3. **`src/lib/contacts/parse-contact-csv.ts`** (editado) — o cabeçalho `curso` passa a ser
   sinônimo de `company`. `company` continua aceito, então planilhas antigas não quebram.
   Se as duas colunas existirem, `company` vence (comportamento antigo preservado) e o
   caso é coberto por teste.

### Textos trocados quando `NEXT_PUBLIC_VERTICAL=educacao` (locale `pt`)

| Chave | Hoje | Vira |
|---|---|---|
| `Contacts.form.companyLabel` | Empresa | Curso de interesse |
| `Contacts.form.companyPlaceholder` | Acme Corp | *(env da instalação)* |
| `Contacts.detailView.company` | Empresa | Curso de interesse |
| `Contacts.page.tableColumns.company` | Empresa | Curso de interesse |
| `Contacts.importModal.columns.company` | Empresa | Curso de interesse |
| `Contacts.importModal.desc` | cita a coluna `company` | cita a coluna `curso` |
| `Inbox.conversationList.company` | Empresa | Curso |
| `Inbox.conversationList.allCompanies` | Todas as empresas | Todos os cursos |
| `Automations.builder.fields.company` | Empresa | Curso de interesse |
| `Flows.builder.form.varKeyPlaceholder` | ex.: nome, email, empresa | ex.: nome, email, curso |

O locale `en` recebe a tabela equivalente (`Course of interest` / `All courses`); locale
sem tabela cai no dicionário original sem erro.

**`Automations.builder.config.placeholderContact` foi removida da tabela na revisão final
(decisão do Miguel, 2026-08-18):** esse texto é o operando passado literalmente para
`.select(cfg.operand)` no motor de automações (`src/lib/automations/engine.ts:679`), então
precisa nomear colunas reais do banco. O upstream em inglês já estava correto
(`name / email / company`); trocar `company` por `curso`/`course` faria a condição
avaliar `false` silenciosamente. O upstream em português (`nome / e-mail / empresa`) já é
impreciso, mas isso é bug pré-existente e fora de escopo aqui.

### Dois textos que citam "empresa" e NÃO podem mudar

Achados na varredura e explicitamente fora da tabela — um teste trava isso:

- `Settings.profile.signatureHint` — "O WhatsApp mostra apenas o nome da empresa para o
  cliente…". Aqui "empresa" é o perfil do WhatsApp da instituição, não o campo do contato.
- `Settings.aiConfig.promptPlaceholder` — "ex.: Somos a Acme, uma loja de equipamentos de
  café…". Exemplo de instrução para a IA, sem relação com o campo.

## Configuração por instalação

| Instalação | `NEXT_PUBLIC_VERTICAL` | `NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE` |
|---|---|---|
| Display4 | *(não definir)* | *(não definir)* |
| Campos Salles | `educacao` | `Direito` |
| Anhembi Morumbi | `educacao` | `Publicidade e Propaganda` |

`NEXT_PUBLIC_*` é inlinado no **build** — trocar o valor exige reimplantar na Hostinger,
como já vale para `NEXT_PUBLIC_APP_NAME`.

## Testes

- `src/lib/vertical.test.ts` (novo):
  - vertical vazia → dicionário devolvido é idêntico ao recebido (protege a Display4);
  - vertical `educacao` → exatamente as 10 chaves da tabela mudam, e nenhuma outra chave
    do dicionário difere (varredura recursiva comparando com o original);
  - `signatureHint` e `promptPlaceholder` seguem intactos, verificados por nome;
  - o exemplo do campo respeita a env e cai no padrão quando ela está vazia.
- `src/lib/contacts/parse-contact-csv.test.ts` (estendido): cabeçalho `curso` popula o
  campo; cabeçalho `company` continua funcionando; ambos presentes → `company` vence.

Os dois testes de `src/lib/dashboard/date-utils.test.ts` (mondayIndex) falham sempre em
máquina UTC-3 — são pré-existentes do upstream e não indicam regressão.

## Fora de escopo

- Renomear a coluna do banco.
- Lista fechada de cursos e tela para gerenciá-la.
- Ajustar fluxos e automações já montados nas instalações.
- Transmissões: o seletor de variável (`contactFields` em `step3-personalize.tsx`) oferece
  apenas nome, telefone e e-mail — o campo empresa não aparece lá, então nada a fazer.
- Migração dos endereços para `crm.valione.com.br/cs` e `/anhembi` — **em standby** por
  decisão de Miguel em 2026-08-18; decisões já levantadas estão no registro do dia.

## Entrega

Implementação no branch `campo-curso-interesse`, a partir de `personalizacao-display4`
(produto). Depois de aprovada, chega às instalações por merge nos branches
`campos-salles` e `anhembi-morumbi`, cada um definindo as suas duas variáveis na
Hostinger e reimplantando.
