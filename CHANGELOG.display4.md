# Changelog — Display4 | CRM

Histórico de versões DESTA instalação (as versões do projeto-base wacrm
ficam no `CHANGELOG.md` original, mantido em arquivo separado para não
conflitar ao puxar atualizações do upstream).

Convenção: **minor** (1.1 → 1.2) a cada deploy com ajustes e novidades;
**major** (2.0) em mudanças grandes. A versão vem do `package.json` e
aparece no rodapé do app; cada versão publicada ganha uma tag git
(`v1.0.0`, `v1.1.0`, ...).

## Atualização do upstream (2026-09-17)

Incorporado `ArnasDon/wacrm` até `80c3f9a` (169 commits). As migrações `037`–`042`
do upstream foram renumeradas para `045`–`050`: o fork já usava `037`–`044` com
conteúdo próprio, e os bancos das três instalações já as tinham registradas. Sem a
renumeração, o banco trataria as novas como aplicadas e o código quebraria em runtime.

**Antes de publicar em qualquer instalação, aplicar as seis migrações `045` a `050`
no banco dela, nessa ordem — não é opcional, e não é só `045`, `047` e `048`.**

- `045` cria o índice único de `messages(conversation_id, message_id)`. Sem ela, o
  recebimento cai num fallback de insert simples (com log de erro) e continua
  funcionando — só a deduplicação fica inativa.
- `047` adiciona a coluna `messages.media_type`. **Sem ela não há fallback**: o
  insert de recebimento — inclusive o fallback da `045` acima — falha com
  `PGRST204`, e **toda mensagem recebida é descartada**, nas três instalações.
- `048` adiciona as colunas `contacts.wa_*`. **Sem ela não há fallback**: todo
  contato **novo** é descartado na hora de gravar, e todo envio de fluxo,
  automação ou IA falha (o `select` que essas rotas fazem em `contacts` exige
  as colunas). Reações também quebram.
- `046`/`049` são necessárias para a criação de broadcast pela API v1 (só afeta
  quem usa templates Meta).

Ou seja: publicar o código antes de aplicar as seis apaga mensagens recebidas
silenciosamente e derruba todo envio automatizado em contas uazapi/waha — não é
um problema cosmético de deduplicação.

Tradução: o `pt.json` oficial do upstream passou a ser a base, com as 281 chaves
exclusivas do fork reaplicadas por cima (`scripts/merge-messages.mjs`). O mesmo script
preenche `es`/`ko` com fallback em inglês (`node scripts/merge-messages.mjs fallback <locale>`).

Comportamento alterado:

- O nó `set_tag` dos fluxos só dispara automações `tag_added` quando a etiqueta é
  nova para o contato (antes disparava em toda passagem).
- Marcar uma tag manualmente (formulário de contato, painel do contato, ou API
  v1) agora também dispara automações `tag_added` — antes só o nó `set_tag` do
  fluxo fazia isso. Na Display4: um atendente marcando manualmente a etiqueta
  que alimenta o funil de vendas agora cria um card no pipeline.
- Um nó `send_buttons` que falha agora encerra a execução do fluxo como
  `failed`, em vez de deixá-la travada. Em uazapi o nó de interativo hoje
  sempre lança erro (é a trava de capability), então qualquer fluxo com
  botões nas instalações atuais vai terminar como `failed` nesse nó.

## v1.12.1 — 2026-08-16

Dois botões consertados, sem mudança de comportamento:

- **"Excluir Pipeline"** estava ilegível — texto vermelho sobre fundo
  vermelho.
- **"Marcar como Ganho / Perdido"** no negócio agora ficam um embaixo do
  outro. Lado a lado, o rótulo em português não cabia e vazava para fora
  do painel.

## v1.12 — 2026-08-16

### Editar o contato de onde ele aparece

Corrigir o nome de um contato — o caso mais comum, quem chega pelo
WhatsApp e entra no CRM só com o telefone — exigia sair da conversa, ir
até Contatos, achar a pessoa na lista, editar e voltar.

Agora o mesmo formulário de sempre (nome, telefone, e-mail, empresa e
tags) abre a partir de três lugares:

- **Painel do contato na Caixa de Entrada** — lápis ao lado do nome.
- **Cabeçalho da conversa** — o nome virou botão.
- **Modal do negócio no funil** — lápis ao lado do seletor de contato.

Salvou, o nome novo aparece na hora no cabeçalho, no painel e na lista de
conversas, sem recarregar a página.

É o formulário já existente, não um segundo jeito de editar contato: as
regras de telefone duplicado e o índice único continuam valendo igual.

Quem tem perfil **viewer** não vê nenhum dos três botões — e a política
do banco já barrava a escrita de qualquer forma.

## v1.11 — 2026-08-16

### Do funil direto para a conversa

O formulário do negócio tinha um link chamado **"Vincular a uma
Conversa"** que não fazia nenhuma das duas coisas: não vinculava (o save
nunca gravava o vínculo) e não levava à conversa (caía na caixa de
entrada genérica).

Agora:

- O botão se chama **"Ver conversa"** e abre a **thread daquele
  contato**, não a lista.
- O negócio passa a **guardar de fato** a conversa. Antes, negócio criado
  pelo board ficava sem vínculo para sempre; só os criados pelo Inbox
  (v1.9) nasciam ligados.
- **Vínculo existente nunca é trocado.** Editar o valor de um negócio
  ligado a uma conversa não o repõe na conversa mais recente do contato
  — a origem da oportunidade se mantém.

Contato sem conversa nenhuma continua sem botão.

Consequência a saber: como a v1.10 apaga os negócios junto com a
conversa, negócios criados pelo board agora também são apagados quando a
conversa vinculada é apagada.

## v1.10 — 2026-08-16

### Apagar conversa

Não havia como apagar uma conversa pelo app. Conversa de teste, engano
ou número errado ficava para sempre no Inbox — a única saída era SQL
direto no banco.

Agora o cabeçalho da conversa tem um menu **⋮** com **"Apagar
conversa"**:

- A conversa sai da lista na hora e aparece um aviso com **Desfazer**.
- Passados **7 segundos** sem desfazer, ela é apagada de verdade, junto
  com todas as mensagens.
- **Os negócios ligados àquela conversa são apagados junto** — e o aviso
  diz exatamente isso ("Conversa e 1 negócio(s) apagados"), para a perda
  nunca ser silenciosa.
- Quem tem papel **visualizador** não vê o menu.

Detalhes:

- A exclusão roda numa transação única no banco: ou apaga conversa e
  negócios, ou não apaga nada.
- Fechar a aba antes dos 7 segundos **cancela** a exclusão — a conversa
  volta ao recarregar. É o lado seguro para errar.
- Enquanto o prazo corre, a conversa ainda existe: se o contato
  responder nesse intervalo, a mensagem é apagada junto.
- Apagar aqui não apaga nada no WhatsApp do contato.

**Requer a migração 044** aplicada no banco antes do deploy.

## v1.9 — 2026-08-15

### Fase do funil pela Caixa de Entrada

Quem atende via o funil na barra lateral do contato, mas não podia agir
sobre ele: para mover um card era preciso sair da conversa e abrir o
board. Na prática a fase envelhecia — o atendente qualificava alguém na
conversa e o funil não refletia isso.

Agora, na seção **Negócios** da barra lateral:

- **A fase virou um botão.** Clicar nela abre as fases do funil daquele
  negócio; escolher uma move o card na hora. Escolher a fase em que ele
  já está não faz nada.
- **"Adicionar a um funil"** cria um negócio sem sair da conversa. O
  menu mostra as fases agrupadas por funil — escolher a fase já define
  o funil, então não há segunda pergunta. O negócio nasce com o nome do
  contato como título (ou o telefone, se não houver nome), valor zero,
  moeda da conta, e **fica vinculado à conversa aberta**, registrando de
  qual atendimento a oportunidade saiu.

Detalhes:

- A mudança é otimista: aparece na hora e, se a gravação falhar, volta
  sozinha com o aviso "Não foi possível mover o negócio".
- Quem tem papel **visualizador** continua só enxergando a fase, sem
  controles — o banco já barrava a escrita, agora a interface acompanha.
- Refinar valor, título ou moeda continua sendo trabalho do board.
- Mudar a fase por aqui **não dispara automações** — não existe gatilho
  de "fase alterada" no produto.

## v1.8 — 2026-08-03

### Nome da assinatura configurável

A v1.7 assinava com o primeiro nome do perfil. Isso não serve para o
padrão mais comum de mesa de atendimento: a persona é fictícia de
propósito ("Ana, do atendimento") e precisa sobreviver à troca de
pessoa — muda o atendente, não muda o nome que o cliente conhece.

Agora, ao ligar a assinatura, aparece o campo **"Nome da assinatura"**:

- **Em branco** → assina com o primeiro nome do perfil (comportamento
  da v1.7, inalterado para quem já ativou).
- **Preenchido** → assina com o que estiver ali. Aceita nome composto
  ("Ana | Atendimento"), até 40 caracteres.

Detalhes:

- Asteriscos e outros caracteres de formatação do WhatsApp são
  removidos do nome — um `*` solto quebraria o negrito do resto da
  mensagem. Quebras de linha viram espaço.
- A prévia no perfil usa exatamente a mesma resolução do envio, então
  o que você vê ali é o que o cliente recebe.
- Migração `043_agent_signature_name.sql` (coluna
  `profiles.signature_name`, opcional, com CHECK de 40 caracteres).

## v1.7 — 2026-08-01

### Assinatura do atendente nas mensagens

O WhatsApp identifica toda mensagem enviada pelo **número da empresa** —
não existe campo de remetente por pessoa. Com mais de um atendente no
Inbox, o cliente via uma voz só. Agora cada atendente pode ativar a
assinatura no próprio perfil (Configurações → Seu perfil → "Assinar suas
mensagens") e o primeiro nome dele passa a abrir a mensagem:

```
*Marcos*
Bom dia! Sobre o orçamento que você pediu…
```

Detalhes:

- **Por atendente, não por conta** — cada um decide, e a opção nasce
  **desligada** (nenhuma instalação muda de comportamento sozinha).
- O nome vem do "Nome de exibição" do perfil; trocar lá muda a
  assinatura, sem cadastro extra.
- **Só o que um humano digita no painel é assinado.** Fluxos,
  automações, transmissões e a API pública (`/api/v1/messages`) seguem
  sem assinatura — não há autor a atribuir.
- Legenda de mídia é assinada; mídia **sem** legenda não ganha legenda
  só com o nome. Templates e mensagens interativas nunca são assinados
  (o corpo é aprovado pela Meta).
- A assinatura entra no texto enviado **e** no histórico, então a
  conversa no Inbox mostra exatamente o que o cliente recebeu.
- Migração `042_agent_signature.sql` (coluna `profiles.signature_enabled`).

## v1.6 — 2026-07-27

- Automações com gatilho **"Tag adicionada"** agora funcionam de fato:
  o bloco "Marcar contato" dos Fluxos passou a disparar as automações
  da tag (com as variáveis capturadas disponíveis para interpolação,
  ex.: título do card com {{vars.nome}}), e o gatilho agora respeita a
  tag ESPECÍFICA configurada — antes, qualquer tag dispararia todas as
  automações desse tipo.

## v1.5 — 2026-07-27

- Novo bloco **"Atualizar contato"** nos Fluxos: grava as respostas
  capturadas (nome, e-mail, empresa) direto no cadastro do contato.
  É a peça que faltava para o funil de qualificação automático —
  boas-vindas → perguntas → cadastro completo → tag → card no
  pipeline via automação "tag adicionada" + "criar negócio".
  (Requer a migração 041 no banco de cada instalação.)

## v1.4 — 2026-07-27

- O status salvo da conexão WhatsApp agora se **auto-corrige**: a tela
  de Configurações já consultava o provedor ao vivo; agora ela grava o
  que descobre. O banner "não conectado" do Inbox passa a acender quando
  o número cai (ex.: bloqueio pelo WhatsApp) e a apagar sozinho depois
  de reconectar — sem SQL manual. Também preenche o telefone conectado
  quando o fluxo do QR foi interrompido antes de gravá-lo.

## v1.3 — 2026-07-27

- Iniciar conversa com **mensagem livre** nos provedores por QR Code
  (Uazapi/WAHA), que não têm a janela de 24h da Meta: botão "+" no topo
  da lista do Inbox (escolhe um contato ou digita um número novo, que
  vira contato automaticamente) e "Enviar mensagem" na ficha do contato.
  Em contas Meta os botões não aparecem — lá a primeira mensagem
  continua tendo de ser um modelo aprovado.

## v1.2 — 2026-07-12

- Rotas de cron (transmissões, automações, fluxos) aceitam o segredo
  também pela URL (`?secret=`), viabilizando pingers gratuitos que não
  enviam headers (cron-job.org, UptimeRobot).

## v1.1 — 2026-07-12

- Azul (Cobalt, cor da marca) como tema padrão para todos os usuários.
- Logo centralizado na tela de login.
- Versão do app exibida no rodapé (sidebar e login).

## v1.0 — 2026-07-12

Primeira versão em produção: https://crm.display4.com.br (Hostinger).

- CRM completo em português (base wacrm + Supabase).
- WhatsApp por três provedores: Meta oficial, WAHA e **Uazapi** (QR Code) —
  conversas, mídia nos dois sentidos, reações, recibos de status. E2E
  validado ao vivo no Uazapi.
- Transmissões (fase 2): texto livre com placeholders (`{{nome}}` e campos
  personalizados), mídia, agendamento e processador em segundo plano com
  ritmo anti-banimento.
- Dashboard de marketing: GA4 + Meta Ads (investimento, leads, CPL,
  campanhas), atribuição de origem das conversas (Anúncio CTWA / Site via
  marcador `[ref:]` / Direto) e custo por conversa. Guia em
  `docs/marketing.md`.
- Rebrand Display4: nome, logo, favicon e assinatura
  "Display4 | CRM by *Valione Intelligence*." — marca parametrizada por
  env (`NEXT_PUBLIC_APP_NAME`) para futuras instalações por cliente.
