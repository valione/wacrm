# Editar contato a partir da conversa e do negócio — plano

> **Para trabalhadores agênticos:** SUB-SKILL OBRIGATÓRIA — use
> superpowers:subagent-driven-development (recomendado) ou
> superpowers:executing-plans para implementar tarefa a tarefa.

**Objetivo:** abrir o `ContactForm` existente a partir do painel lateral do
Inbox, do cabeçalho da conversa e do modal do negócio, sem perder as tags do
contato.

**Arquitetura:** um envelope (`ContactEditDialog`) carrega contato + tags e
só então monta o `ContactForm`. Os três gatilhos usam esse envelope. A
página do Inbox recebe o contato salvo e atualiza `activeContact` e o
`contact` embutido nas conversas.

**Stack:** Next.js 16, Supabase JS, next-intl, sonner, vitest, lucide-react.

## Restrições globais

- Spec: `docs/superpowers/specs/2026-08-16-editar-contato-na-conversa-design.md`
- Sem migração de banco.
- Gatilhos escondidos para `isViewer` (a RLS `contacts_update` é a barreira
  real).
- Textos novos em `messages/pt.json` **e** `messages/en.json`.
- Branch: `personalizacao-display4`.
- O repositório não tem jsdom — nada de teste de renderização.

---

### Task 1: A guarda e o envelope

**Arquivos:**
- Criar: `src/lib/contacts/edit-dialog-state.ts`
- Criar: `src/lib/contacts/edit-dialog-state.test.ts`
- Criar: `src/components/contacts/contact-edit-dialog.tsx`
- Criar: `src/components/contacts/contact-edit-dialog.test.ts`

**Interfaces produzidas:**
- `isReadyToEdit(contact: Contact | null, tags: ContactTag[] | null): boolean`
- `<ContactEditDialog contactId open onOpenChange onSaved />` com
  `onSaved: (contact: Contact) => void`

- [ ] **Passo 1: teste da guarda (falhando)**

`src/lib/contacts/edit-dialog-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isReadyToEdit } from "./edit-dialog-state";
import type { Contact } from "@/types";

const contact = { id: "c1", phone: "5511999" } as Contact;

describe("isReadyToEdit", () => {
  it("espera enquanto as tags não chegaram", () => {
    expect(isReadyToEdit(contact, null)).toBe(false);
  });

  it("libera quando o contato não tem tag nenhuma", () => {
    expect(isReadyToEdit(contact, [])).toBe(true);
  });

  it("libera com tags carregadas", () => {
    expect(
      isReadyToEdit(contact, [{ id: "ct1", contact_id: "c1", tag_id: "t1" }]),
    ).toBe(true);
  });

  it("não libera sem contato", () => {
    expect(isReadyToEdit(null, [])).toBe(false);
  });
});
```

- [ ] **Passo 2: rodar e ver falhar**

`npx vitest run src/lib/contacts/edit-dialog-state.test.ts`
Esperado: FAIL — módulo não encontrado.

- [ ] **Passo 3: escrever a guarda**

`src/lib/contacts/edit-dialog-state.ts`:

```ts
//
// Quando é seguro montar o ContactForm para edição.
//
// `ContactForm` popula as tags selecionadas num efeito que roda ao abrir
// (deps `[open, contact]`, NÃO `contactTags`) e, ao salvar, apaga todas as
// linhas de contact_tags e regrava as selecionadas. Montar o formulário
// antes de as tags chegarem abre com nenhuma marcada — e salvar apaga as
// tags do contato em silêncio.
//
// Por isso `null` (carregando) e `[]` (carregado, sem tags) são estados
// diferentes: só o segundo libera.

import type { Contact, ContactTag } from "@/types";

export function isReadyToEdit(
  contact: Contact | null,
  tags: ContactTag[] | null,
): boolean {
  return !!contact && tags !== null;
}
```

- [ ] **Passo 4: rodar e ver passar**

`npx vitest run src/lib/contacts/edit-dialog-state.test.ts`
Esperado: PASS (4 testes).

- [ ] **Passo 5: escrever o envelope**

`src/components/contacts/contact-edit-dialog.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type { Contact, ContactTag } from "@/types";
import { isReadyToEdit } from "@/lib/contacts/edit-dialog-state";
import { ContactForm } from "@/components/contacts/contact-form";

interface ContactEditDialogProps {
  contactId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Recebe o contato relido depois do save — quem chamou usa para
   *  atualizar a tela sem recarregar. */
  onSaved: (contact: Contact) => void;
}

export function ContactEditDialog({
  contactId,
  open,
  onOpenChange,
  onSaved,
}: ContactEditDialogProps) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [tags, setTags] = useState<ContactTag[] | null>(null);

  const fetchContact = useCallback(async (): Promise<Contact | null> => {
    if (!contactId) return null;
    const supabase = createClient();
    const { data } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .maybeSingle();
    return data ?? null;
  }, [contactId]);

  // Carrega contato e tags juntos. Enquanto `tags` for null o formulário
  // NÃO monta — ver isReadyToEdit.
  useEffect(() => {
    if (!open || !contactId) {
      setContact(null);
      setTags(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [contactRes, tagsRes] = await Promise.all([
        supabase.from("contacts").select("*").eq("id", contactId).maybeSingle(),
        supabase.from("contact_tags").select("*").eq("contact_id", contactId),
      ]);
      if (cancelled) return;
      if (contactRes.error || tagsRes.error || !contactRes.data) {
        toast.error(contactRes.error?.message ?? tagsRes.error?.message ?? "");
        onOpenChange(false);
        return;
      }
      setContact(contactRes.data);
      setTags(tagsRes.data ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId, onOpenChange]);

  const handleSaved = useCallback(async () => {
    const fresh = await fetchContact();
    if (fresh) onSaved(fresh);
  }, [fetchContact, onSaved]);

  if (!isReadyToEdit(contact, tags)) return null;

  return (
    <ContactForm
      open={open}
      onOpenChange={onOpenChange}
      contact={contact}
      contactTags={tags ?? []}
      onSaved={handleSaved}
    />
  );
}
```

- [ ] **Passo 6: teste de regressão do contrato**

`src/components/contacts/contact-edit-dialog.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Fixa a guarda contra remoção futura. Sem ela, o ContactForm monta antes
// de as tags chegarem e o save apaga todas as tags do contato em silêncio
// — falha invisível, sem erro e sem toast. O repositório não tem jsdom,
// então o contrato é fixado lendo o fonte.
describe("ContactEditDialog", () => {
  const source = readFileSync(
    join(process.cwd(), "src/components/contacts/contact-edit-dialog.tsx"),
    "utf8",
  );

  it("não monta o ContactForm antes da guarda isReadyToEdit", () => {
    const guard = source.indexOf("isReadyToEdit(contact, tags)");
    const form = source.indexOf("<ContactForm");
    expect(guard).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(guard);
  });

  it("passa as tags carregadas para o formulário", () => {
    expect(source).toContain("contactTags={tags");
  });
});
```

- [ ] **Passo 7: rodar os dois arquivos**

`npx vitest run src/lib/contacts/edit-dialog-state.test.ts src/components/contacts/contact-edit-dialog.test.ts`
Esperado: PASS (6 testes).

- [ ] **Passo 8: commit**

```bash
git add src/lib/contacts/edit-dialog-state.ts \
        src/lib/contacts/edit-dialog-state.test.ts \
        src/components/contacts/contact-edit-dialog.tsx \
        src/components/contacts/contact-edit-dialog.test.ts
git commit -m "feat: envelope de edição de contato que espera as tags"
```

---

### Task 2: Gatilhos no Inbox

**Arquivos:**
- Modificar: `src/components/inbox/contact-sidebar.tsx`
- Modificar: `src/components/inbox/message-thread.tsx`
- Modificar: `src/app/(dashboard)/inbox/page.tsx`
- Modificar: `messages/pt.json`, `messages/en.json`

**Interfaces consumidas:** `<ContactEditDialog>` da Task 1.

- [ ] **Passo 1: chaves de tradução**

Em `messages/pt.json`, dentro de `Inbox.sidebar` e de `Inbox.messageThread`,
adicionar em cada um:

```json
"editContact": "Editar contato"
```

Em `messages/en.json`, nos mesmos dois objetos:

```json
"editContact": "Edit contact"
```

- [ ] **Passo 2: lápis no painel lateral**

Em `src/components/inbox/contact-sidebar.tsx`:

Adicionar `Pencil` ao import de `lucide-react` e, no topo do arquivo:

```tsx
import { ContactEditDialog } from "@/components/contacts/contact-edit-dialog";
```

Estender as props:

```tsx
interface ContactSidebarProps {
  contact: Contact | null;
  conversationId?: string;
  /** Contato relido depois de editado aqui — a página propaga para o
   *  cabeçalho e para a lista de conversas. */
  onContactSaved?: (contact: Contact) => void;
}
```

E a desestruturação:

```tsx
export function ContactSidebar({
  contact,
  conversationId,
  onContactSaved,
}: ContactSidebarProps) {
```

Adicionar o estado, junto dos outros `useState`:

```tsx
  const [editOpen, setEditOpen] = useState(false);
```

Trocar o bloco do nome (hoje um `<h3>` solto) por nome + lápis:

```tsx
            <div className="mt-3 flex items-center gap-1.5">
              <h3 className="text-sm font-semibold text-foreground">
                {displayName}
              </h3>
              {!isViewer && (
                <button
                  type="button"
                  onClick={() => setEditOpen(true)}
                  aria-label={tSidebar("editContact")}
                  title={tSidebar("editContact")}
                  className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="size-3.5" />
                </button>
              )}
            </div>
```

E, no fim do JSX retornado (irmão do `ScrollArea`, dentro do `<div>` raiz):

```tsx
      <ContactEditDialog
        contactId={contact.id}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={(updated) => {
          setEditOpen(false);
          onContactSaved?.(updated);
        }}
      />
```

- [ ] **Passo 3: nome clicável no cabeçalho**

Em `src/components/inbox/message-thread.tsx`:

Adicionar ao import de `lucide-react` o ícone `Pencil` (usado como
affordance ao lado do nome) e importar o envelope:

```tsx
import { ContactEditDialog } from "@/components/contacts/contact-edit-dialog";
```

Estender as props do componente com:

```tsx
  onContactSaved?: (contact: Contact) => void;
```

e adicioná-la à desestruturação. Junto dos outros `useState`:

```tsx
  const [editContactOpen, setEditContactOpen] = useState(false);
```

No cabeçalho, trocar

```tsx
              <h2 className="truncate text-sm font-semibold text-foreground">{displayName}</h2>
```

por

```tsx
              {isViewer ? (
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {displayName}
                </h2>
              ) : (
                <button
                  type="button"
                  onClick={() => setEditContactOpen(true)}
                  title={t("editContact")}
                  className="group flex min-w-0 items-center gap-1 rounded text-left hover:bg-muted"
                >
                  <h2 className="truncate text-sm font-semibold text-foreground">
                    {displayName}
                  </h2>
                  <Pencil className="size-3 flex-shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              )}
```

E, logo antes do fechamento do `<div>` raiz do componente:

```tsx
      {contact && (
        <ContactEditDialog
          contactId={contact.id}
          open={editContactOpen}
          onOpenChange={setEditContactOpen}
          onSaved={(updated) => {
            setEditContactOpen(false);
            onContactSaved?.(updated);
          }}
        />
      )}
```

- [ ] **Passo 4: propagação na página do Inbox**

Em `src/app/(dashboard)/inbox/page.tsx`, adicionar o handler junto dos
outros `useCallback`:

```tsx
  // Nome/e-mail/empresa mudaram numa das telas. O objeto salvo já veio
  // do envelope, então dá para atualizar tudo sem refetch: o painel e o
  // cabeçalho leem `activeContact`, a lista lê o `contact` embutido em
  // cada conversa.
  const handleContactSaved = useCallback((updated: Contact) => {
    setActiveContact((prev) => (prev?.id === updated.id ? updated : prev));
    setConversations((prev) =>
      prev.map((c) =>
        c.contact_id === updated.id ? { ...c, contact: updated } : c,
      ),
    );
  }, []);
```

Passar para os dois componentes:

```tsx
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            ...
            onContactSaved={handleContactSaved}
          />
```

```tsx
            <ContactSidebar
              contact={activeContact}
              conversationId={activeConversation?.id}
              onContactSaved={handleContactSaved}
            />
```

- [ ] **Passo 5: typecheck**

`npx tsc --noEmit`
Esperado: sem erros. Se `Contact` não estiver importado em
`message-thread.tsx` ou na página, adicionar ao import de `@/types`.

- [ ] **Passo 6: commit**

```bash
git add src/components/inbox/contact-sidebar.tsx \
        src/components/inbox/message-thread.tsx \
        "src/app/(dashboard)/inbox/page.tsx" \
        messages/pt.json messages/en.json
git commit -m "feat: editar contato pelo painel e pelo cabeçalho da conversa"
```

---

### Task 3: Gatilho no Pipeline

**Arquivos:**
- Modificar: `src/components/pipelines/deal-form.tsx`
- Modificar: `messages/pt.json`, `messages/en.json`

- [ ] **Passo 1: chave de tradução**

Em `messages/pt.json`, dentro de `Pipelines.form`:

```json
"editContact": "Editar contato"
```

Em `messages/en.json`, no mesmo objeto:

```json
"editContact": "Edit contact"
```

(O namespace real usado pelo componente é `Pipelines.form` —
`deal-form.tsx:57`.)

- [ ] **Passo 2: lápis ao lado do seletor**

Em `src/components/pipelines/deal-form.tsx`:

```tsx
import { ContactEditDialog } from "@/components/contacts/contact-edit-dialog";
```

Adicionar `Pencil` ao import de `lucide-react`, pegar `isViewer`:

```tsx
  const { accountId, defaultCurrency, isViewer } = useAuth();
```

Estado, junto dos outros:

```tsx
  const [editContactOpen, setEditContactOpen] = useState(false);
```

Envolver o `<select>` de contato numa linha com o botão:

```tsx
              <div className="flex items-center gap-2">
                <select
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                >
                  <option value="">{t("selectContact")}</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.phone}
                    </option>
                  ))}
                </select>
                {!isViewer && contactId && (
                  <button
                    type="button"
                    onClick={() => setEditContactOpen(true)}
                    aria-label={t("editContact")}
                    title={t("editContact")}
                    className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                )}
              </div>
```

E, antes do fechamento do `<Dialog>`, o envelope — que atualiza a lista do
seletor com o nome novo:

```tsx
      <ContactEditDialog
        contactId={contactId || null}
        open={editContactOpen}
        onOpenChange={setEditContactOpen}
        onSaved={(updated) => {
          setEditContactOpen(false);
          setContacts((prev) =>
            prev.map((c) => (c.id === updated.id ? updated : c)),
          );
        }}
      />
```

- [ ] **Passo 3: typecheck**

`npx tsc --noEmit`
Esperado: sem erros.

- [ ] **Passo 4: commit**

```bash
git add src/components/pipelines/deal-form.tsx messages/pt.json messages/en.json
git commit -m "feat: editar contato a partir do negócio"
```

---

### Task 4: Fechamento

- [ ] **Passo 1: suíte completa**

`npx vitest run`
Esperado: tudo verde, incluindo os 6 testes novos.

- [ ] **Passo 2: typecheck final**

`npx tsc --noEmit`
Esperado: sem saída.

- [ ] **Passo 3: fumaça manual**

Contra uma instalação com dados reais (a Display4). Roteiro na spec — o
teste 1 é o que importa: **contato com tags, editar o nome pelo painel, e
confirmar que as tags continuam lá**. Antes de começar, anotar as tags do
contato escolhido; depois de salvar, conferir uma a uma.

- [ ] **Passo 4: CHANGELOG e tag**

Acrescentar a v1.12.0 em `CHANGELOG.display4.md` no padrão das anteriores,
commitar como `chore: v1.12.0 — editar contato de onde ele aparece` e
`git tag v1.12.0`.

- [ ] **Passo 5: finalizar a branch**

Usar superpowers:finishing-a-development-branch.
