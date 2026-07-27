# Nó "atualizar contato" nos Fluxos + funil de qualificação Display4 — Design

**Data:** 2026-07-27 · **Status:** aprovado no brainstorm (Miguel)

## Problema

O funil de qualificação da Display4 (boas-vindas → coleta nome/empresa/
e-mail → aviso de encaminhamento → card no pipeline) é montável quase
inteiro com blocos existentes:

- Fluxo com gatilho `first_inbound_message`: `send_message` →
  `collect_input` ×3 → `send_message` → `set_tag` → `handoff`.
- Automação com gatilho `tag_added` + passo `create_deal` abre o card.

A lacuna: `collect_input` grava as respostas em `flow_runs.vars`, que
morrem com a execução — nada as leva para o CADASTRO do contato. O
consultor herda um contato sem nome/empresa/e-mail e um card cujo
título não interpola o nome real.

## Solução: node_type `update_contact`

Nó de efeito (sem mensagem ao cliente, auto-advance — mesma classe do
`set_tag`): copia variáveis capturadas para colunas do contato.

### Config

```ts
export interface UpdateContactNodeConfig {
  /**
   * Mapeamentos var → coluna. `phone` fica de fora de propósito:
   * é a identidade do contato (dedup da migração 022) e já é
   * conhecida — reescrevê-la a partir de texto do cliente poderia
   * quebrar o vínculo da conversa.
   */
  fields: Array<{
    field: 'name' | 'email' | 'company';
    /** Chave em flow_runs.vars (a mesma usada no collect_input). */
    var_key: string;
  }>;
  next_node_key: string;
}
```

### Semântica no engine

- Para cada mapeamento: se `vars[var_key]` existir e não for vazia,
  grava `contacts.<field> = trim(valor)` (update único com todos os
  campos presentes + `updated_at`).
- Sobrescreve valor existente: sim. O lead acabou de informar o dado —
  é mais confiável que o pushName do WhatsApp que povoou `name`.
- Falha de escrita: não-fatal — `logEvent('error', reason:
  'update_contact_failed')` e avança (mesma política do `set_tag`:
  erro interno não pode encalhar o cliente no meio da conversa).
- Var ausente/vazia: pula o campo em silêncio e registra no evento
  (`skipped_fields`) para diagnóstico.

### Pontos tocados (espelham o `set_tag`/`send_media`)

1. Migração `041_flow_update_contact.sql` — drop/recreate do CHECK de
   `flow_nodes.node_type` incluindo `update_contact` (padrão da 016).
2. `src/lib/flows/types.ts` — interface + união `FlowNodeConfig`.
3. `src/lib/flows/engine.ts` — `isAutoAdvancing` + caso de execução.
4. `src/lib/flows/validate.ts` — config: `fields` não-vazio, `field`
   no enum, `var_key` presente; aviso (warning) quando `var_key` não
   corresponde a nenhum `collect_input` a montante não é viável
   estaticamente (vars são dinâmicas) — fica de fora.
5. `src/lib/flows/edges.ts` — aresta única "next" (2 pontos).
6. Builder (`src/components/flows/`) — entrada no menu de adicionar,
   formulário (linhas campo→var com adicionar/remover), rótulo do
   card no canvas.
7. i18n `messages/{pt,en}.json`.
8. Testes: engine (grava, pula vazio, falha não-fatal) e validate.

## Montagem na Display4 (configuração, sem código)

Fluxo "Qualificação de leads" (gatilho: primeira mensagem recebida):

1. `send_message` — boas-vindas
2. `collect_input` prompt "Qual o seu nome?" → var `nome`
3. `collect_input` prompt "De qual empresa você fala?" → var `empresa`
4. `collect_input` prompt "Qual o seu e-mail?" → var `email`
5. `update_contact` — name←`nome`, company←`empresa`, email←`email`
6. `send_message` — "Obrigado, {{vars.nome}}! Vou te direcionar…"
7. `set_tag` — `lead-qualificado`
8. `handoff` — sem atribuição (triagem geral)

Automação "Card de lead qualificado" (gatilho: tag `lead-qualificado`
adicionada): passo único `create_deal` no pipeline existente da
Display4 (Miguel escolhe pipeline/etapa no builder), título
interpolando o nome do contato — que o nó novo acabou de gravar.

Ativação: depende do WhatsApp da Display4 voltar (API oficial Meta em
migração). O fluxo pode ser montado e salvo desativado.

## Fora de escopo

- Validação de formato do e-mail no `collect_input` (o campo
  `validation` é reservado para v2 do runner; gravamos o que o lead
  digitar).
- Atualizar `phone` ou campos personalizados (v2, se surgir demanda —
  ex.: RA do aluno na Anhembi via custom field).
- Encadear automação a partir do fluxo por outro meio que não a tag.

## Riscos

- Dado sujo (lead digita "asdf" no e-mail) → aceito no v1; validação
  de runner é evolução separada.
- Sobrescrita do nome vindo do WhatsApp → desejada (decisão acima).
