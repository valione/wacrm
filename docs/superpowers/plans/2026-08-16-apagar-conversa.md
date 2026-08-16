# Apagar conversa pelo Inbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o atendente apaga uma conversa inteira pelo cabeçalho da thread, com 7 segundos para desfazer; os negócios vinculados vão junto, numa transação só.

**Architecture:** uma função no banco (`delete_conversation_with_deals`, `SECURITY INVOKER`) apaga negócios + conversa atomicamente e devolve quantas conversas apagou; um helper puro monta o texto do aviso; o `message-thread.tsx` ganha o item de menu e a página do Inbox concentra o fluxo de exclusão adiada (timer, desfazer, reversão).

**Tech Stack:** Postgres/Supabase (migração + RPC via `supabase.rpc`), Next.js 16 / React, sonner 2.0.7 (toast com `action`), next-intl, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-apagar-conversa-design.md`

## Global Constraints

- **A migração 044 cria SÓ a função.** Nenhuma tabela ou coluna muda.
- **`SECURITY INVOKER` + `SET search_path = public`** — padrão do projeto (`025_filter_contacts_by_tags.sql`).
- **A função retorna `INTEGER`** (quantas conversas apagou). A RLS filtra em silêncio: sem permissão o DELETE não afeta linhas e NÃO levanta erro. O cliente trata `0` como falha.
- **Janela de desfazer: 7 segundos.**
- **O dropdown é base-ui, NÃO Radix**: `DropdownMenuItem` usa `onClick` (`onSelect` é ignorado e o `tsc` não acusa); `DropdownMenuTrigger` não aceita `asChild`.
- **i18n nos DOIS arquivos**: `messages/pt.json` e `messages/en.json`.
- **Viewer não vê a ação** (`isViewer` do `useAuth`); a RLS (`conversations_delete`, migração 017) é a barreira real.
- **NÃO fazer `git push`** e **NÃO aplicar a migração em banco de cliente** sem o Miguel mandar.

## File Structure

| Arquivo | Papel |
|---|---|
| `supabase/migrations/044_delete_conversation.sql` (novo) | A função transacional. |
| `src/lib/conversations/delete-notice.ts` (novo) | Helper puro: chave i18n + contagem para o texto do aviso. |
| `src/lib/conversations/delete-notice.test.ts` (novo) | Testes do helper. |
| `src/components/inbox/message-thread.tsx` (modificar) | Item "Apagar conversa" no menu do cabeçalho. |
| `src/app/(dashboard)/inbox/page.tsx` (modificar) | Fluxo: remoção otimista, timer de 7s, desfazer, reversão. |
| `messages/pt.json`, `messages/en.json` (modificar) | Chaves novas. |

---

### Task 1: Migração 044 — função transacional

**Files:**
- Create: `supabase/migrations/044_delete_conversation.sql`

**Interfaces:**
- Produces: `public.delete_conversation_with_deals(p_conversation_id UUID) RETURNS INTEGER`. Task 3 chama via `supabase.rpc("delete_conversation_with_deals", { p_conversation_id })`.

- [ ] **Step 1: Escrever a migração**

```sql
-- ============================================================
-- 044_delete_conversation
--
-- Apagar uma conversa pelo app, levando junto os negócios ligados
-- a ela.
--
-- Por que uma função e não dois DELETEs do cliente: `deals` e
-- `conversations` precisam cair juntas. Duas chamadas separadas
-- podem falhar no meio e deixar negócios apagados sob uma conversa
-- que continua de pé — perda silenciosa de oportunidade. Uma função
-- é uma transação: ou vai tudo, ou não vai nada.
--
-- Por que os negócios morrem junto (e não `SET NULL`): decisão do
-- produto. `deals.conversation_id` (001) não tem regra de exclusão,
-- então o Postgres BLOQUEIA o delete da conversa enquanto houver
-- negócio apontando — e a v1.9 passou a criar negócios já ligados à
-- conversa pelo Inbox, tornando esse bloqueio o caso comum.
--
-- SECURITY INVOKER: as políticas de quem chama valem. Nenhuma regra
-- nova de permissão — `conversations_delete` e `deals_delete` (017)
-- já exigem papel `agent`.
--
-- O retorno existe porque a RLS filtra CALADA: sem permissão o
-- DELETE não afeta linha alguma e não levanta erro. Sem devolver a
-- contagem, a interface mostraria "apagado" para quem não apagou
-- nada.
--
-- Cascatas que o banco já resolve: messages, message_actions e
-- notifications somem; flow_runs e registros de IA ficam órfãos
-- (SET NULL), de propósito — o histórico de execução sobrevive.
-- ============================================================

CREATE OR REPLACE FUNCTION public.delete_conversation_with_deals(
  p_conversation_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM deals WHERE conversation_id = p_conversation_id;
  DELETE FROM conversations WHERE id = p_conversation_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

GRANT EXECUTE ON FUNCTION public.delete_conversation_with_deals(UUID)
  TO authenticated;
```

- [ ] **Step 2: Conferir a sintaxe sem tocar em banco de cliente**

Não aplicar em Display4 nem Campos Salles. A verificação de sintaxe fica para a hora do deploy (o Miguel decide onde aplicar).

Run: `grep -c "GET DIAGNOSTICS" supabase/migrations/044_delete_conversation.sql`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/044_delete_conversation.sql
git commit -m "feat: migração 044 — função para apagar conversa com negócios"
```

---

### Task 2: Helper puro do texto do aviso

**Files:**
- Create: `src/lib/conversations/delete-notice.ts`
- Test: `src/lib/conversations/delete-notice.test.ts`

**Interfaces:**
- Produces: `deleteNotice(dealCount: number): { key: "deletedNoDeals" | "deletedWithDeals"; count: number }`. Task 3 usa a `key` para escolher a mensagem e `count` para interpolar.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/conversations/delete-notice.test.ts
import { describe, expect, it } from "vitest";
import { deleteNotice } from "./delete-notice";

describe("deleteNotice", () => {
  it("sem negócios, usa a mensagem simples", () => {
    expect(deleteNotice(0)).toEqual({ key: "deletedNoDeals", count: 0 });
  });

  it("com negócios, informa a contagem", () => {
    expect(deleteNotice(1)).toEqual({ key: "deletedWithDeals", count: 1 });
    expect(deleteNotice(3)).toEqual({ key: "deletedWithDeals", count: 3 });
  });

  it("trata contagem negativa ou não finita como zero", () => {
    expect(deleteNotice(-2)).toEqual({ key: "deletedNoDeals", count: 0 });
    expect(deleteNotice(Number.NaN)).toEqual({
      key: "deletedNoDeals",
      count: 0,
    });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/conversations/delete-notice.test.ts`
Expected: FAIL — módulo `./delete-notice` não encontrado.

- [ ] **Step 3: Implementar**

```ts
// src/lib/conversations/delete-notice.ts
//
// Qual aviso mostrar ao apagar uma conversa. Puro de propósito: a
// escolha entre "só a conversa" e "a conversa e N negócios" é a
// única regra aqui que merece teste, e o aviso é o ÚNICO sinal que
// o usuário recebe sobre os negócios que estão indo junto.

export interface DeleteNotice {
  key: "deletedNoDeals" | "deletedWithDeals";
  count: number;
}

export function deleteNotice(dealCount: number): DeleteNotice {
  const count =
    Number.isFinite(dealCount) && dealCount > 0 ? Math.floor(dealCount) : 0;
  return count === 0
    ? { key: "deletedNoDeals", count: 0 }
    : { key: "deletedWithDeals", count };
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/conversations/delete-notice.test.ts`
Expected: PASS — 3 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/conversations/delete-notice.ts src/lib/conversations/delete-notice.test.ts
git commit -m "feat: helper do aviso de conversa apagada"
```

---

### Task 3: Fluxo de exclusão na página do Inbox

**Files:**
- Modify: `src/app/(dashboard)/inbox/page.tsx`
- Modify: `messages/pt.json`, `messages/en.json`

**Interfaces:**
- Consumes: `deleteNotice` (Task 2); a RPC da Task 1.
- Produces: `handleDeleteConversation(conversationId: string): Promise<void>`, passada ao `MessageThread` na Task 4 como prop `onDelete`.

- [ ] **Step 1: i18n**

Em `messages/pt.json`, dentro de `Inbox` → `messageThread` (mesma seção onde ficam `status`/`unassign`):

```json
"deleteConversation": "Apagar conversa",
"deletedNoDeals": "Conversa apagada",
"deletedWithDeals": "Conversa e {count} negócio(s) apagados",
"undo": "Desfazer",
"deleteFailed": "Não foi possível apagar a conversa"
```

Em `messages/en.json`, mesma seção:

```json
"deleteConversation": "Delete conversation",
"deletedNoDeals": "Conversation deleted",
"deletedWithDeals": "Conversation and {count} deal(s) deleted",
"undo": "Undo",
"deleteFailed": "Could not delete the conversation"
```

- [ ] **Step 2: Imports e handler na página**

Imports novos no topo de `src/app/(dashboard)/inbox/page.tsx` (o `toast` do sonner já está importado — ver o warning de import não usado no lint):

```tsx
import { deleteNotice } from "@/lib/conversations/delete-notice";
```

Handler, junto aos demais `useCallback` da página (perto de `handleCloseConversation`, linha ~495):

```tsx
/**
 * Exclusão adiada: some da lista agora, apaga no banco depois de 7s.
 *
 * Limitação conhecida e aceita (ver spec): o timer vive no navegador.
 * Fechar a aba antes dos 7s CANCELA a exclusão — a conversa reaparece
 * ao recarregar. É o lado seguro para errar.
 */
const handleDeleteConversation = useCallback(
  async (conversationId: string) => {
    const supabase = createClient();

    const removed = conversations.find((c) => c.id === conversationId);
    if (!removed) return;

    // Contagem só para o texto do aviso — os negócios são apagados
    // pela função do banco, não aqui.
    const { data: dealRows } = await supabase
      .from("deals")
      .select("id")
      .eq("conversation_id", conversationId);
    const notice = deleteNotice(dealRows?.length ?? 0);

    setConversations((prev) => prev.filter((c) => c.id !== conversationId));
    if (activeConversation?.id === conversationId) handleCloseConversation();

    let undone = false;
    const timer = setTimeout(async () => {
      if (undone) return;
      const { data, error } = await supabase.rpc(
        "delete_conversation_with_deals",
        { p_conversation_id: conversationId },
      );
      // `data === 0` = a RLS filtrou tudo em silêncio (sem permissão).
      if (error || data === 0) {
        setConversations((prev) =>
          [removed, ...prev].sort(
            (a, b) =>
              new Date(b.last_message_at ?? b.created_at).getTime() -
              new Date(a.last_message_at ?? a.created_at).getTime(),
          ),
        );
        toast.error(tThread("deleteFailed"));
      }
    }, 7000);

    toast(tThread(notice.key, { count: notice.count }), {
      duration: 7000,
      action: {
        label: tThread("undo"),
        onClick: () => {
          undone = true;
          clearTimeout(timer);
          setConversations((prev) =>
            [removed, ...prev].sort(
              (a, b) =>
                new Date(b.last_message_at ?? b.created_at).getTime() -
                new Date(a.last_message_at ?? a.created_at).getTime(),
            ),
          );
        },
      },
    });
  },
  [conversations, activeConversation, handleCloseConversation, tThread],
);
```

- [ ] **Step 3: Adicionar `tThread` na página**

A página hoje tem só `const t = useTranslations("Inbox.page");` (linha 28). As chaves novas vivem em `Inbox.messageThread` (onde fica o botão), então acrescente logo abaixo:

```tsx
const tThread = useTranslations("Inbox.messageThread");
```

- [ ] **Step 4: Verificar**

Run: `npx tsc --noEmit`
Expected: limpo.

Run: `node -e "['pt','en'].forEach(l=>{const d=require('./messages/'+l+'.json').Inbox.messageThread;console.log(l, d.deleteConversation, '|', d.undo)})"`
Expected: as chaves nos dois idiomas.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(dashboard)/inbox/page.tsx" messages/pt.json messages/en.json
git commit -m "feat: fluxo de exclusão de conversa com desfazer de 7s"
```

---

### Task 4: Item "Apagar conversa" no cabeçalho

**Files:**
- Modify: `src/components/inbox/message-thread.tsx`

**Interfaces:**
- Consumes: `handleDeleteConversation` (Task 3) via prop nova.
- Produces: prop `onDelete?: (conversationId: string) => void` em `MessageThreadProps`.

- [ ] **Step 1: Prop nova**

Em `interface MessageThreadProps` (linha ~69), junto às demais:

```tsx
  /**
   * Apagar a conversa inteira. Opcional: sem o handler, o item não
   * aparece. Quem executa é a página do Inbox (exclusão adiada com
   * desfazer).
   */
  onDelete?: (conversationId: string) => void;
```

E na desestruturação do componente, acrescente `onDelete` à lista de props.

- [ ] **Step 2: Menu no cabeçalho**

Imports: acrescente `Trash2` e `MoreVertical` à lista do `lucide-react`. O `useAuth` já está importado e é chamado na linha 177 como `const { user } = useAuth();`.

Logo APÓS o `</DropdownMenu>` do menu "Assign" (linha ~1090), ainda dentro da `<div>` de ações do cabeçalho:

```tsx
          {/* Ações destrutivas — fora da lista lateral de propósito,
              para não virar clique acidental. */}
          {onDelete && conversation && !isViewer && (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
                <MoreVertical className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => onDelete(conversation.id)}
                  className="text-sm text-destructive"
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  {t("deleteConversation")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
```

Na linha 177, acrescente `isViewer` à desestruturação que já existe (não chame o hook uma segunda vez):

```tsx
const { user, isViewer } = useAuth();
```

- [ ] **Step 3: Ligar na página**

Em `src/app/(dashboard)/inbox/page.tsx`, no `<MessageThread ...>` (linha ~641), acrescente:

```tsx
            onDelete={handleDeleteConversation}
```

- [ ] **Step 4: Verificar**

Run: `npx tsc --noEmit && npx eslint src/components/inbox/message-thread.tsx "src/app/(dashboard)/inbox/page.tsx"`
Expected: typecheck limpo, sem erro novo de lint.

Run: `grep -c "onSelect={" src/components/inbox/message-thread.tsx`
Expected: `0` — base-ui ignora `onSelect` e o `tsc` não acusa.

- [ ] **Step 5: Commit**

```bash
git add src/components/inbox/message-thread.tsx "src/app/(dashboard)/inbox/page.tsx"
git commit -m "feat: item apagar conversa no cabeçalho da thread"
```

---

### Task 5: Verificação final

**Files:** nenhum novo.

- [ ] **Step 1: Suíte e typecheck**

Run: `npx vitest run`
Expected: verde, EXCETO as 2 falhas pré-existentes de `src/lib/dashboard/date-utils.test.ts` (`mondayIndex`, dependentes de fuso UTC-3, upstream — não são regressão).

Run: `npx tsc --noEmit`
Expected: limpo.

- [ ] **Step 2: Fumaça (exige a migração 044 aplicada no banco de teste)**

- [ ] Apagar conversa SEM negócio → some da lista, aviso "Conversa apagada"
- [ ] Esperar 7s e recarregar → continua apagada
- [ ] Apagar conversa COM negócio → aviso diz "Conversa e 1 negócio(s) apagados"
- [ ] Recarregar → o negócio sumiu também do board do funil
- [ ] Apagar e clicar em **Desfazer** → conversa volta à lista; recarregar confirma que ela E o negócio continuam lá
- [ ] Entrar como `viewer` → o menu de três pontos não aparece

- [ ] **Step 3: Release — SÓ com o OK do Miguel**

Bump `1.9.0 → 1.10.0` em `package.json`, entrada no `CHANGELOG.display4.md`, tag `v1.10.0`.

**Atenção — esta leva tem migração.** A 044 precisa ser aplicada em CADA instalação antes do deploy do código, senão o item de menu chama uma função que não existe: Display4 (`hhnmzwuuqyllydfdpmxs`), Campos Salles (`gjdadqzwrdvjwrsdfaga`) e Anhembi (`mqfiqrrlarmuumwzbkid`). Ordem segura: aplicar a migração nos três bancos → depois `git push` nas três branches.
