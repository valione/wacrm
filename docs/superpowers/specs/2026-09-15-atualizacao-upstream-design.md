# Atualização do upstream (ArnasDon/wacrm) — design

**Data:** 2026-09-15
**Status:** aprovado por Miguel, pronto para plano
**Branch de integração:** `atualizacao-upstream` (a partir de `personalizacao-display4` `09db7c4`)

## Problema

O fork e o upstream divergiram em **2026-07-10** (`b867760`) e seguiram caminhos próprios:

| | Commits desde a divergência | Arquivos tocados |
|---|---|---|
| Fork (`personalizacao-display4`) | 113 | 165 |
| Upstream (`upstream/main` = `80c3f9a`, 2026-09-13) | 169 | 172 |
| **Interseção** | — | **40 arquivos** |

Miguel decidiu **ficar em dia de vez**, não fazer colheita seletiva. O fork precisa absorver
os 169 commits sem perder o que é dele: marca por instalação, provedores WAHA e Uazapi,
transmissões (fase 2), painel de marketing, assinatura do atendente, exclusão de conversa,
fase do funil no Inbox e a vertical de educação.

## Riscos levantados (com evidência)

### 1. Colisão de numeração de migrações — o risco central

Os dois lados criaram migrações com os **mesmos números e conteúdos diferentes**:

| Nº | Fork | Upstream |
|---|---|---|
| 037 | `whatsapp_provider` | `webhook_broadcast_reliability` |
| 038 | `provider_generalization` | `broadcast_resume` |
| 039 | `broadcast_content` | `inbound_media_mirror` |
| 040 | `marketing` | `contact_business_scoped_user_id` |
| 041 | `flow_update_contact` | `fix_broadcast_contact_id_ambiguity` |
| 042 | `agent_signature` | `message_failure_reason` |
| 043 | `agent_signature_name` | — |
| 044 | `delete_conversation` | — |

Os três bancos já registraram as versões `037`–`044` **com o conteúdo do fork** em
`supabase_migrations.schema_migrations`. Aplicar as homônimas do upstream com os mesmos
números faria o banco tratá-las como já aplicadas — as colunas e tabelas que o código novo
espera **não existiriam**, e a falha apareceria em runtime, não no deploy. O projeto já
tropeçou nisso: a migração `034` existe por causa de uma chave duplicada em
`schema_migrations` (SQLSTATE 23505).

**Decisão:** renumerar as 6 do upstream para **045–050**, preservando a ordem relativa
original. As 8 do fork ficam intocadas.

### 2. A migração 037 do upstream APAGA linhas

`037_webhook_broadcast_reliability.sql:49-64` roda um `DELETE FROM messages` que remove
duplicatas de `(conversation_id, message_id)` mantendo a mais antiga, para então criar um
índice único. O comentário da migração argumenta que é seguro (`reply_to_message_id` é
`ON DELETE SET NULL`, reações têm cascade).

**Decisão:** antes de aplicar em cada banco, rodar a contagem equivalente
(`SELECT count(*) ... WHERE rn > 1`). Zero linhas → aplicar direto. Qualquer número acima de
zero → parar, mostrar a Miguel quantas e de quais conversas, e só seguir com o aval dele.
Mensagem de cliente apagada não volta.

### 3. Bancos sem backup automático

As três instalações estão no plano gratuito do Supabase, que não tem backup automático —
risco registrado e aceito desde o início, mas este trabalho é o primeiro a aplicar DDL
destrutivo. **Decisão:** dump manual dos três bancos antes de qualquer migração, guardado
fora do repositório.

### 4. Traduções divergentes

O upstream ganhou tradução oficial para `pt`. Contagem de chaves (achatadas):

- upstream: 1730
- fork: 1706
- **só no fork: 281** (marketing, nova conversa, excluir conversa, origem do contato, editar
  contato pelo Inbox…) — some se o arquivo oficial for adotado cru, deixando buracos na UI
- só no upstream: 305 (ganho)

**Decisão de Miguel:** a tradução oficial vence; as 281 chaves exclusivas do fork são
reaplicadas por cima. Verificado: **as 10 chaves usadas por `src/lib/vertical.ts` existem no
`pt.json` oficial**, então a vertical de educação sobrevive ao merge.

## Estratégia

Branch de integração único, conflitos resolvidos **em camadas, da mais perigosa para a menos**,
com a suíte rodando a cada camada. Nada publicado até tudo passar.

Descartadas: (a) adotar o upstream e reescrever as personalizações por cima — o fork tem
features que o upstream não tem, "recolocar por cima" viraria reescrever, com risco de perder
trabalho sem perceber; (b) validar num 4º app da Hostinger + Supabase de teste — é o mais
seguro, mas custa um app e um projeto, e a combinação de dumps + publicação escalonada
(começando pela instalação sem cliente) cobre o mesmo risco a custo zero.

### Camada 0 — Rede de segurança

- Dump dos três bancos (Display4 `hhnmzwuuqyllydfdpmxs`, CS `gjdadqzwrdvjwrsdfaga`,
  Anhembi `mqfiqrrlarmuumwzbkid`), guardados fora do repositório.
- Confirmar o ponto de partida verde: 821 passando, 2 falhas conhecidas de fuso em
  `date-utils.test.ts` (mondayIndex, pré-existentes do upstream, UTC-3).
- Conferir se o projeto Supabase da Anhembi não está pausado por inatividade (plano free pausa
  após ~7 dias sem tráfego; sintoma é HTTP 544 na Management API, conserto é
  `POST /v1/projects/<ref>/restore`).

### Camada 1 — Migrações

Renumerar as 6 do upstream para 045–050 no merge, preservando a ordem relativa.
**Não aplicar ainda** — a aplicação acontece na publicação (Camada 6), instalação por
instalação. Análise de cada uma:

| Novo nº | Origem | O que faz | Risco |
|---|---|---|---|
| 045 | 037 `webhook_broadcast_reliability` | `DELETE` de duplicatas em `messages`, índice único `(conversation_id, message_id)`, função atômica de unread | **ALTO — destrutiva.** Trava de contagem obrigatória (risco 2) |
| 046 | 038 `broadcast_resume` | `ALTER` em `broadcast_recipients`/`broadcasts`; `DROP`+`CREATE` de `create_broadcast_with_recipients`, que ganha o parâmetro `p_template_params JSONB[]` | Baixo — **verificado: o fork não chama essa função em lugar nenhum** (a fase 2 de transmissões substituiu esse caminho). Após o merge, confirmar qual caminho de criação de transmissão fica valendo |
| 047 | 039 `inbound_media_mirror` | `ALTER TABLE` aditivo em `messages` e `whatsapp_config` | Baixo |
| 048 | 040 `contact_business_scoped_user_id` | 3 colunas novas em `contacts` + índice único **parcial** (`WHERE wa_user_id IS NOT NULL`) | Baixo — **verificado:** as colunas nascem `NULL`, então o índice não abrange nenhuma linha existente e não pode falhar por duplicata |
| 049 | 041 `fix_broadcast_contact_id_ambiguity` | Só redefinição de função | Baixo |
| 050 | 042 `message_failure_reason` | `ALTER TABLE` aditivo em `messages` | Baixo |

Todas exceto a 045 são seguras de aplicar antes do deploy do código novo, porque só
acrescentam. A 045 tem janela própria (ver Camada 6).

### Camada 2 — Backend crítico

Conflitos em `src/app/api/whatsapp/webhook/route.ts`, `send/route.ts`, `config/route.ts`,
`react/route.ts`, `src/app/api/automations/cron/route.ts`. É onde uma resolução errada
quebra recebimento de mensagem sem erro visível. Cada arquivo resolvido com os testes da
área rodando.

### Camada 3 — Telas

Inbox, fluxos, transmissões, configurações, contatos (~25 arquivos da interseção). Conflito
mais visível e menos perigoso.

### Camada 4 — Traduções

Script determinístico: `messages/pt.json` e `en.json` do upstream como base, reaplicando as
chaves exclusivas do fork. O script é versionado junto (não é edição manual), para poder ser
reexecutado e auditado. Depois, `src/lib/vertical.test.ts` confirma que as 10 chaves da
vertical continuam existindo — é exatamente o teste-guarda escrito em agosto para este
cenário.

### Camada 5 — Dependências e build

`npm install` após o merge de `package.json` / `package-lock.json`, `npm run typecheck`,
`npm run build`. Nota: `npm run lint` já emite 1 erro e 37 warnings pré-existentes e
`format:check` falha em ~425 arquivos — dívida anterior ao trabalho, fora de escopo. **Nunca
rodar `npm run format`** (reformata o repo inteiro e afoga o diff).

### Camada 6 — Verificação e publicação escalonada

Verificação antes de publicar:
1. Suíte completa verde (exceto as 2 falhas de fuso conhecidas).
2. `typecheck` e `build` limpos.
3. **Teste ao vivo obrigatório**: enviar e receber uma mensagem real. O merge mexe no webhook
   e no envio; nenhum teste automático prova que mensagem de verdade ainda chega. Exige um
   número conectado e o webhook apontando para a instalação testada.

Publicação, uma instalação de cada vez, com intervalo de observação entre elas:

1. **Anhembi Morumbi** — uso interno do Miguel, sem cliente pagante. Cobaia real.
2. **Display4** — produção, cliente.
3. **Campos Salles** — cliente pagante, por último.

Para cada uma: aplicar as migrações 045–050 no banco (com a checagem do `DELETE` da 037),
depois `git merge` no branch da instalação e push (deploy automático da Hostinger, ~90s).

## Fora de escopo

- Multi-canal (mais de um número por instalação) — Miguel adiou; `whatsapp_config` tem
  `UNIQUE (account_id)` e suportar vários exige propagar canal por todo o sistema.
- Botões da Uazapi via `/send/menu` — próximo trabalho, depois deste (as correções de botões
  do upstream chegam neste merge e facilitam aquele).
- Dívida de lint e formatação pré-existente.
- Renumerar ou consolidar as migrações do fork.

## Critérios de conclusão

- `personalizacao-display4` contém `upstream/main` (`git merge-base --is-ancestor upstream/main
  personalizacao-display4` verdadeiro).
- Suíte, typecheck e build verdes.
- Teste ao vivo de mensagem real passou.
- As três instalações no ar com as migrações 045–050 aplicadas e registradas.
- A vertical de educação continua funcionando (campo "Curso de interesse" nas duas faculdades).
