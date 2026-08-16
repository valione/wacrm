# Ver a conversa a partir do negócio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o link do formulário do negócio passa a levar à conversa certa (`/inbox?c=<id>`), e o formulário passa a gravar de fato o `conversation_id` — preservando sempre o vínculo que o negócio já tem.

**Architecture:** uma função pura decide qual conversa vale (`existing ?? detected ?? null`); o `deal-form.tsx` usa esse resultado nos dois lugares — no `href` do botão e no `payload` do save. Sem migração: `deals.conversation_id` existe desde a 001.

**Tech Stack:** Next.js 16 / React, Supabase JS client, next-intl, vitest.

**Spec:** `docs/superpowers/specs/2026-08-16-ver-conversa-do-negocio-design.md`

## Global Constraints

- **Sem migração.** `deals.conversation_id` já existe (001_initial_schema.sql:273).
- **Deep-link existente:** `/inbox?c=<id>` — mesmo padrão de `notifications/page.tsx:119` e `dashboard/queries.ts:323`. Não inventar rota nova.
- **Vínculo existente NUNCA é sobrescrito** — é a razão de a regra ser função pura e testada.
- **i18n nos DOIS arquivos** (`messages/pt.json`, `messages/en.json`): entra `viewConversation`, sai `linkToConversation` (usada só em `deal-form.tsx:293`).
- **NÃO fazer `git push`** sem o Miguel mandar.

## File Structure

| Arquivo | Papel |
|---|---|
| `src/lib/deals/resolve-conversation.ts` (novo) | A regra de resolução, pura. |
| `src/lib/deals/resolve-conversation.test.ts` (novo) | Testes da regra. |
| `src/components/pipelines/deal-form.tsx` (modificar) | Usa a regra no `href` e no `payload`. |
| `messages/pt.json`, `messages/en.json` (modificar) | Troca da chave. |

---

### Task 1: Regra de resolução

**Files:**
- Create: `src/lib/deals/resolve-conversation.ts`
- Test: `src/lib/deals/resolve-conversation.test.ts`

**Interfaces:**
- Produces: `resolveDealConversationId(existing: string | null | undefined, detected: string | null | undefined): string | null`. A Task 2 usa esse nome exato.

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/deals/resolve-conversation.test.ts
import { describe, expect, it } from "vitest";
import { resolveDealConversationId } from "./resolve-conversation";

describe("resolveDealConversationId", () => {
  it("preserva o vínculo que o negócio já tem", () => {
    expect(resolveDealConversationId("conv-A", "conv-B")).toBe("conv-A");
  });

  it("usa a conversa detectada quando não há vínculo", () => {
    expect(resolveDealConversationId(null, "conv-B")).toBe("conv-B");
    expect(resolveDealConversationId(undefined, "conv-B")).toBe("conv-B");
  });

  it("devolve null quando não há nenhuma das duas", () => {
    expect(resolveDealConversationId(null, null)).toBeNull();
    expect(resolveDealConversationId(undefined, undefined)).toBeNull();
  });

  it("trata string vazia como ausência", () => {
    expect(resolveDealConversationId("", "conv-B")).toBe("conv-B");
    expect(resolveDealConversationId("", "")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/deals/resolve-conversation.test.ts`
Expected: FAIL — módulo `./resolve-conversation` não encontrado.

- [ ] **Step 3: Implementar**

```ts
// src/lib/deals/resolve-conversation.ts
//
// Qual conversa um negócio aponta.
//
// A ordem importa: o vínculo JÁ GRAVADO vence a conversa detectada pelo
// contato. Sem isso, editar o valor de um negócio ligado à conversa A
// regravaria o vínculo para a B (a mais recente do contato), e a origem
// da oportunidade se perderia em silêncio.

export function resolveDealConversationId(
  existing: string | null | undefined,
  detected: string | null | undefined,
): string | null {
  return existing || detected || null;
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/deals/resolve-conversation.test.ts`
Expected: PASS — 4 testes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/deals/resolve-conversation.ts src/lib/deals/resolve-conversation.test.ts
git commit -m "feat: regra de resolução da conversa do negócio"
```

---

### Task 2: Botão "Ver conversa" e gravação do vínculo

**Files:**
- Modify: `src/components/pipelines/deal-form.tsx`
- Modify: `messages/pt.json`, `messages/en.json`

**Interfaces:**
- Consumes: `resolveDealConversationId` (Task 1).

- [ ] **Step 1: i18n — trocar a chave**

Em `messages/pt.json` (linha 558), **substituir**:

```json
      "linkToConversation": "Vincular a uma Conversa",
```

por:

```json
      "viewConversation": "Ver conversa",
```

Em `messages/en.json` (linha 558), **substituir**:

```json
      "linkToConversation": "Link to Conversation",
```

por:

```json
      "viewConversation": "View conversation",
```

- [ ] **Step 2: Import da regra**

No topo de `src/components/pipelines/deal-form.tsx`, junto aos demais imports:

```tsx
import { resolveDealConversationId } from "@/lib/deals/resolve-conversation";
```

- [ ] **Step 3: Derivar o id uma vez só**

Logo antes de `async function handleSave()` (linha ~153), acrescentar:

```tsx
  // Uma fonte só para o botão e para o save — não podem divergir.
  const conversationId = resolveDealConversationId(
    deal?.conversation_id,
    linkedConversation?.id,
  );
```

- [ ] **Step 4: Gravar no payload**

No `payload` de `handleSave` (linhas 160-169), acrescentar a linha final:

```tsx
    const payload = {
      title: title.trim(),
      value: parseFloat(value) || 0,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      notes: notes.trim() || null,
      expected_close_date: expectedCloseDate || null,
      conversation_id: conversationId,
    };
```

- [ ] **Step 5: Corrigir o botão**

Substituir o bloco das linhas 287-295:

```tsx
              {linkedConversation && (
                <Link
                  href="/inbox"
                  className="mt-1 inline-flex items-center gap-1.5 self-start rounded-md bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                >
                  <MessageSquare className="h-3 w-3" />
                  {t("linkToConversation")}
                </Link>
              )}
```

por:

```tsx
              {conversationId && (
                <Link
                  href={`/inbox?c=${conversationId}`}
                  className="mt-1 inline-flex items-center gap-1.5 self-start rounded-md bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
                >
                  <MessageSquare className="h-3 w-3" />
                  {t("viewConversation")}
                </Link>
              )}
```

- [ ] **Step 6: Verificar**

Run: `npx tsc --noEmit`
Expected: limpo.

Run: `grep -rn "linkToConversation" src/ messages/`
Expected: nenhuma saída — a chave antiga não sobrou em lugar nenhum.

Run: `npx eslint src/components/pipelines/deal-form.tsx`
Expected: sem erro novo.

- [ ] **Step 7: Commit**

```bash
git add src/components/pipelines/deal-form.tsx messages/pt.json messages/en.json
git commit -m "fix: botão do negócio leva à conversa certa e grava o vínculo"
```

---

### Task 3: Verificação final

**Files:** nenhum novo.

- [ ] **Step 1: Suíte e typecheck**

Run: `npx vitest run`
Expected: verde, EXCETO as 2 falhas pré-existentes de `src/lib/dashboard/date-utils.test.ts` (`mondayIndex`, fuso UTC-3, upstream — não são regressão).

Run: `npx tsc --noEmit`
Expected: limpo.

- [ ] **Step 2: Fumaça**

- [ ] Abrir um negócio de contato que tenha conversa → o botão diz **"Ver conversa"**
- [ ] Clicar → abre o Inbox **com a thread daquele contato aberta** (não a lista genérica)
- [ ] Criar um negócio novo pelo board para um contato com conversa → salvar, reabrir, e o botão continua aparecendo (sinal de que o vínculo foi gravado)
- [ ] Editar só o valor de um negócio vinculado → salvar → o botão continua levando à MESMA conversa
- [ ] Abrir negócio de contato sem conversa nenhuma → nenhum botão aparece

- [ ] **Step 3: Release — SÓ com o OK do Miguel**

Bump `1.10.0 → 1.11.0` em `package.json`, entrada no `CHANGELOG.display4.md`, tag `v1.11.0`. **Sem migração nesta leva** — publicar é só o push nas três branches (`personalizacao-display4`, `campos-salles`, `anhembi-morumbi`), sem a coordenação que a v1.10 exigiu.
