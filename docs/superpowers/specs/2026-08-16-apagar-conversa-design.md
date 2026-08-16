# Apagar conversa pelo Inbox — Design

**Data:** 2026-08-16 · **Status:** aprovado no brainstorm (Miguel)

## Problema

Não existe forma de apagar uma conversa pelo app. Conversas de teste,
engano ou número errado ficam para sempre no Inbox, e a única saída hoje é
SQL direto no banco — foi o que aconteceu na Display4 em 2026-07-27
(115 conversas / 5812 mensagens apagadas na mão).

## O que já existe (e será reusado)

- `conversations_delete` (migração 017) já exige papel `agent`:
  `USING (is_account_member(account_id, 'agent'))`. Nenhuma política nova.
- Cascatas já resolvidas pelo banco ao apagar uma conversa:
  - `messages`, `message_actions`, `notifications` → `ON DELETE CASCADE`
  - `flow_runs`, registros de IA → `ON DELETE SET NULL` (sobrevivem órfãos)
- `deals.conversation_id` (001_initial_schema.sql:273) **não tem regra de
  exclusão** — o padrão do Postgres bloqueia. Um DELETE direto falha com
  erro de chave estrangeira sempre que houver negócio vinculado, e a v1.9
  tornou isso comum (deals criados pelo Inbox nascem com a conversa).
- Padrão de RPC do projeto: `SECURITY INVOKER` + `SET search_path = public`
  (ver `025_filter_contacts_by_tags.sql`).
- Menu do cabeçalho da conversa (`message-thread.tsx:1003+`) já hospeda as
  ações "Status" e "Atribuir".

## Decisões do brainstorm

1. **Apagar de verdade, com desfazer imediato** (não lixeira). A exclusão
   é adiada 7 segundos no cliente; "Desfazer" cancela.
2. **O negócio vinculado é apagado junto.** Miguel escolheu isso ciente da
   alternativa recomendada (desvincular e preservar o negócio). Mitigação:
   o aviso diz explicitamente quantos negócios estão sendo levados.
3. **Qualquer atendente apaga** (papel `agent` para cima) — igual ao que a
   RLS já permite.
4. **Só conversa inteira.** Apagar mensagem avulsa não entra.

## Escopo

### 1. Migração 044 — função transacional

`public.delete_conversation_with_deals(p_conversation_id UUID)`:

- `LANGUAGE plpgsql`, `SECURITY INVOKER`, `SET search_path = public`
- `DELETE FROM deals WHERE conversation_id = p_conversation_id;`
- `DELETE FROM conversations WHERE id = p_conversation_id;`
- Uma função = uma transação: ou apaga os dois, ou nada.
- Como é `SECURITY INVOKER`, as políticas do chamador valem: um `viewer`
  não apaga nada mesmo chamando a função direto pela API.
- **Retorna `INTEGER`** — quantas conversas foram apagadas (0 ou 1), lido
  de `GET DIAGNOSTICS ... ROW_COUNT` após o segundo DELETE. Isso existe
  porque a RLS filtra silenciosamente: sem permissão, o DELETE não afeta
  linha alguma e **não levanta erro**. Sem esse retorno, a interface
  mostraria "apagado" para quem não apagou nada. O cliente trata `0` como
  falha e devolve a conversa à lista.
- `GRANT EXECUTE` para `authenticated`.

### 2. Ação no cabeçalho da conversa

- Item **"Apagar conversa"**, em vermelho, no menu do cabeçalho da thread,
  ao lado de Status e Atribuir. **Não** aparece na lista lateral — evita
  clique acidental.
- Escondido para `viewer` (`isViewer` do `useAuth`).

### 3. Fluxo de exclusão

1. Ao clicar, contar os negócios da conversa:
   `select id from deals where conversation_id = <id>` (só para o texto).
2. Remover a conversa da lista e fechar a thread (otimista).
3. Mostrar aviso com ação **Desfazer**, por 7 segundos:
   - sem negócios: "Conversa apagada"
   - com negócios: "Conversa e N negócio(s) apagados"
4. Passados os 7s, chamar a RPC.
5. "Desfazer" cancela o timer e devolve a conversa à lista. Nada é
   apagado.
6. Se a RPC falhar, a conversa volta à lista com aviso de erro.

## Erros e casos de contorno

| Situação | Comportamento |
|---|---|
| Aba fechada antes dos 7s | Exclusão NÃO acontece; conversa reaparece ao recarregar |
| Contato responde na janela dos 7s | A mensagem entra e é apagada junto |
| Outro usuário com Inbox aberto | Continua vendo a conversa até a exclusão efetivar |
| RPC falha (erro) | Conversa volta à lista + aviso de erro |
| RPC retorna 0 (sem permissão) | Tratado como falha: conversa volta + aviso |
| Papel viewer | Item não aparece; RLS barra mesmo por chamada direta |

As três primeiras são consequências aceitas do modelo "desfazer imediato"
em vez de lixeira, e foram apresentadas ao Miguel antes da decisão.

## Testes

- Teste unitário da função pura que monta o texto do aviso a partir da
  contagem de negócios: 0 → "Conversa apagada"; 1 → singular; 2+ → plural.
- Verificação manual: apagar conversa sem negócio; apagar com negócio e
  conferir que sumiu do funil; usar Desfazer e confirmar que a conversa
  volta e o negócio continua no board; conferir que `viewer` não vê a ação.

## Fora de escopo (de propósito)

- Lixeira e restauração após a exclusão efetivada.
- Apagar mensagem individual.
- Apagar várias conversas de uma vez.
- Apagar a mensagem no WhatsApp do contato ("apagar para todos") — o CRM
  mexe apenas no próprio banco.
- Registro de auditoria de quem apagou o quê.
