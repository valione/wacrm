# Fase do pipeline pela Caixa de Entrada — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** o atendente move a fase de um negócio (e cria um negócio novo num funil) direto pela barra lateral do Inbox, sem abrir o board.

**Architecture:** um helper puro agrupa fases por funil (única parte com teste unitário); um arquivo novo de componentes "burros" (`DealStageSelect` e `AddToPipelineMenu`, sobre o DropdownMenu existente); o `contact-sidebar.tsx` ganha a carga de funis/fases, os dois handlers (mover com update otimista, criar com insert) e o gate de viewer; o Inbox passa a conversa ativa por prop nova.

**Tech Stack:** Next.js 16 / React, Supabase JS client (escrita direta do cliente, RLS como barreira), Radix DropdownMenu já embrulhado em `src/components/ui/dropdown-menu.tsx`, sonner para toasts, next-intl, vitest.

**Spec:** `docs/superpowers/specs/2026-08-15-fase-pipeline-no-inbox-design.md`

## Global Constraints

- **Nenhuma migração de banco.** `deals`, `pipelines` e `pipeline_stages` já têm tudo.
- **Insert de deal precisa de `user_id` (NOT NULL desde a 001) e `status: "open"`** (mesmo literal de `deal-form.tsx:200`; o DEFAULT da coluna é `'active'`, divergência herdada — seguir o formulário).
- **Leituras sem filtro de conta explícito** — `from("pipelines").select("*")` etc. seguem o padrão do codebase de confiar na RLS (ver `pipelines/page.tsx:76-95`).
- **i18n sempre nos DOIS arquivos:** `messages/pt.json` e `messages/en.json`, seção `Inbox.sidebar`.
- **Viewer não vê controle nenhum** (`isViewer` do `useAuth`); a RLS de `deals` (migração 017, papel mínimo `agent`) é a barreira real.
- **Toasts via `sonner`** (`import { toast } from "sonner"`), como no resto do app.
- **NÃO fazer `git push`** — deploy é decisão do Miguel (Hostinger está no limite de processos; push na branch dispara build).

## File Structure

| Arquivo | Papel |
|---|---|
| `src/lib/pipelines/stage-groups.ts` (novo) | Helper puro: agrupa/ordena fases por funil. Única lógica testável isolada. |
| `src/lib/pipelines/stage-groups.test.ts` (novo) | Testes do helper. |
| `src/components/inbox/deal-pipeline-controls.tsx` (novo) | Os dois componentes de UI, sem acesso a dados: `DealStageSelect`, `AddToPipelineMenu`. |
| `src/components/inbox/contact-sidebar.tsx` (modificar) | Carrega funis/fases, handlers de mover/criar, gate de viewer, prop `conversationId`. |
| `src/app/(dashboard)/inbox/page.tsx:664` (modificar) | Passa `conversationId={activeConversation?.id}`. |
| `messages/pt.json` + `messages/en.json` (modificar) | Chaves novas em `Inbox.sidebar`. |

---

### Task 1: Helper puro `groupStagesByPipeline`

**Files:**
- Create: `src/lib/pipelines/stage-groups.ts`
- Test: `src/lib/pipelines/stage-groups.test.ts`

**Interfaces:**
- Consumes: tipos `Pipeline` e `PipelineStage` de `@/types` (já existem em `src/types/index.ts:374-388`).
- Produces: `interface PipelineStageGroup { pipeline: Pipeline; stages: PipelineStage[] }` e `function groupStagesByPipeline(pipelines: Pipeline[], stages: PipelineStage[]): PipelineStageGroup[]`. Task 2 e 3 dependem desses nomes exatos.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/pipelines/stage-groups.test.ts
import { describe, expect, it } from "vitest";
import type { Pipeline, PipelineStage } from "@/types";
import { groupStagesByPipeline } from "./stage-groups";

function pipeline(id: string, name: string): Pipeline {
  return { id, user_id: "u1", name, created_at: "2026-01-01T00:00:00Z" };
}

function stage(
  id: string,
  pipeline_id: string,
  position: number,
  name = `stage-${id}`,
): PipelineStage {
  return {
    id,
    pipeline_id,
    name,
    position,
    color: "#3b82f6",
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("groupStagesByPipeline", () => {
  it("agrupa fases sob o funil dono, preservando a ordem dos funis", () => {
    const p1 = pipeline("p1", "Vendas");
    const p2 = pipeline("p2", "Pós-venda");
    const groups = groupStagesByPipeline(
      [p1, p2],
      [stage("s3", "p2", 0), stage("s1", "p1", 0), stage("s2", "p1", 1)],
    );
    expect(groups.map((g) => g.pipeline.id)).toEqual(["p1", "p2"]);
    expect(groups[0].stages.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(groups[1].stages.map((s) => s.id)).toEqual(["s3"]);
  });

  it("ordena as fases por position, mesmo com entrada fora de ordem", () => {
    const groups = groupStagesByPipeline(
      [pipeline("p1", "Vendas")],
      [stage("s2", "p1", 2), stage("s0", "p1", 0), stage("s1", "p1", 1)],
    );
    expect(groups[0].stages.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("mantém a ordem de entrada quando positions empatam (sort estável)", () => {
    const groups = groupStagesByPipeline(
      [pipeline("p1", "Vendas")],
      [stage("sa", "p1", 0), stage("sb", "p1", 0)],
    );
    expect(groups[0].stages.map((s) => s.id)).toEqual(["sa", "sb"]);
  });

  it("omite funil sem nenhuma fase", () => {
    const groups = groupStagesByPipeline(
      [pipeline("p1", "Vendas"), pipeline("p2", "Vazio")],
      [stage("s1", "p1", 0)],
    );
    expect(groups.map((g) => g.pipeline.id)).toEqual(["p1"]);
  });

  it("ignora fase de funil desconhecido e devolve vazio sem funis", () => {
    expect(groupStagesByPipeline([], [stage("s1", "fantasma", 0)])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pipelines/stage-groups.test.ts`
Expected: FAIL — `Cannot find module './stage-groups'` (ou equivalente de resolução).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/pipelines/stage-groups.ts
//
// Agrupamento puro de fases por funil para os controles do Inbox
// (barra lateral do contato). Sem I/O — testável isoladamente.
import type { Pipeline, PipelineStage } from "@/types";

export interface PipelineStageGroup {
  pipeline: Pipeline;
  stages: PipelineStage[];
}

/**
 * Agrupa `stages` sob o funil dono, na ordem em que `pipelines` chegou
 * (as queries já ordenam por created_at), com as fases por `position`
 * (sort estável: empates preservam a ordem de entrada). Funis sem fase
 * são omitidos — não há o que escolher neles.
 */
export function groupStagesByPipeline(
  pipelines: Pipeline[],
  stages: PipelineStage[],
): PipelineStageGroup[] {
  const byPipeline = new Map<string, PipelineStage[]>();
  for (const stage of stages) {
    const bucket = byPipeline.get(stage.pipeline_id);
    if (bucket) bucket.push(stage);
    else byPipeline.set(stage.pipeline_id, [stage]);
  }

  const groups: PipelineStageGroup[] = [];
  for (const pipeline of pipelines) {
    const bucket = byPipeline.get(pipeline.id);
    if (!bucket || bucket.length === 0) continue;
    groups.push({
      pipeline,
      stages: [...bucket].sort((a, b) => a.position - b.position),
    });
  }
  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pipelines/stage-groups.test.ts`
Expected: PASS — 5 testes verdes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipelines/stage-groups.ts src/lib/pipelines/stage-groups.test.ts
git commit -m "feat: helper puro de fases por funil p/ controles do Inbox"
```

---

### Task 2: Seletor de fase por negócio na barra lateral

**Files:**
- Create: `src/components/inbox/deal-pipeline-controls.tsx`
- Modify: `src/components/inbox/contact-sidebar.tsx`
- Modify: `messages/pt.json`, `messages/en.json` (seção `Inbox.sidebar`)

**Interfaces:**
- Consumes: `groupStagesByPipeline` / `PipelineStageGroup` da Task 1; `DropdownMenu*` de `@/components/ui/dropdown-menu`; `useAuth().isViewer`.
- Produces: componente `DealStageSelect({ deal, stages, onSelect }: { deal: Deal; stages: PipelineStage[]; onSelect: (stage: PipelineStage) => void })`. Task 3 acrescenta `AddToPipelineMenu` NESTE MESMO arquivo.

- [ ] **Step 1: Criar `deal-pipeline-controls.tsx` com o `DealStageSelect`**

```tsx
// src/components/inbox/deal-pipeline-controls.tsx
//
// Controles de funil da barra lateral do Inbox. Componentes "burros":
// nenhum acesso a dados — quem grava é o contact-sidebar.
"use client";

import { ChevronDown, Check } from "lucide-react";
import type { Deal, PipelineStage } from "@/types";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

/**
 * O badge de fase do deal, agora clicável: abre as fases do funil DESTE
 * deal. Escolher a fase atual não chama `onSelect` (spec: sem escrita).
 */
export function DealStageSelect({
  deal,
  stages,
  onSelect,
}: {
  deal: Deal;
  stages: PipelineStage[];
  onSelect: (stage: PipelineStage) => void;
}) {
  if (!deal.stage) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px]"
          style={{
            backgroundColor: `${deal.stage.color}20`,
            color: deal.stage.color,
          }}
        >
          {deal.stage.name}
          <ChevronDown className="h-2.5 w-2.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {stages.map((stage) => (
          <DropdownMenuItem
            key={stage.id}
            className="text-xs"
            onSelect={() => {
              if (stage.id !== deal.stage_id) onSelect(stage);
            }}
          >
            <span
              className="mr-2 h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: stage.color }}
            />
            {stage.name}
            {stage.id === deal.stage_id && (
              <Check className="ml-auto h-3 w-3" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: i18n — chave do toast de falha ao mover**

Em `messages/pt.json`, dentro de `Inbox.sidebar` (após `"addNotePlaceholder"`):

```json
"toastMoveFailed": "Não foi possível mover o negócio"
```

Em `messages/en.json`, mesmo lugar:

```json
"toastMoveFailed": "Could not move the deal"
```

- [ ] **Step 3: Ligar no `contact-sidebar.tsx`**

3a. Imports novos no topo (junto aos existentes):

```tsx
import { toast } from "sonner";
import type { Pipeline, PipelineStage } from "@/types";
import { groupStagesByPipeline } from "@/lib/pipelines/stage-groups";
import { DealStageSelect } from "@/components/inbox/deal-pipeline-controls";
```

3b. No hook de auth, pegar também `isViewer` (linha ~33, hoje `const { accountId } = useAuth();`):

```tsx
const { accountId, isViewer } = useAuth();
```

3c. Estado novo, junto aos `useState` existentes:

```tsx
const [pipelines, setPipelines] = useState<Pipeline[]>([]);
const [stages, setStages] = useState<PipelineStage[]>([]);
```

3d. No `fetchContactData`, ampliar o `Promise.all` (hoje com 3 queries, linhas 46-60) para 5 — as duas novas seguem o padrão RLS-sem-filtro de `pipelines/page.tsx:76-95`:

```tsx
const [dealsRes, notesRes, tagsRes, pipelinesRes, stagesRes] =
  await Promise.all([
    supabase
      .from("deals")
      .select("*, stage:pipeline_stages(*)")
      .eq("contact_id", contact.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("contact_notes")
      .select("*")
      .eq("contact_id", contact.id)
      .order("created_at", { ascending: false }),
    supabase
      .from("contact_tags")
      .select("id, tag_id, tags(*)")
      .eq("contact_id", contact.id),
    supabase.from("pipelines").select("*").order("created_at"),
    supabase.from("pipeline_stages").select("*").order("position"),
  ]);
```

E, junto aos `if (dealsRes.data) ...` existentes:

```tsx
if (pipelinesRes.data) setPipelines(pipelinesRes.data);
if (stagesRes.data) setStages(stagesRes.data);
```

3e. Grupos derivados + handler de mover (depois de `handleAddNote`, antes do `if (!contact)`):

```tsx
const stageGroups = groupStagesByPipeline(pipelines, stages);

// Update otimista, mesmo movimento do board (pipelines/page.tsx:224):
// muda na hora, reverte com toast se a escrita falhar. RLS (papel
// mínimo agent, migração 017) é a barreira real.
const handleMoveDeal = useCallback(
  async (deal: Deal, stage: PipelineStage) => {
    const previous = deals;
    setDeals((current) =>
      current.map((d) =>
        d.id === deal.id ? { ...d, stage_id: stage.id, stage } : d,
      ),
    );
    const supabase = createClient();
    const { error } = await supabase
      .from("deals")
      .update({ stage_id: stage.id })
      .eq("id", deal.id);
    if (error) {
      setDeals(previous);
      toast.error(tSidebar("toastMoveFailed"));
    }
  },
  [deals, tSidebar],
);
```

3f. No JSX da lista de deals (linhas ~236-246), trocar o badge estático pelo seletor — viewer continua vendo o badge de hoje:

```tsx
{deal.stage &&
  (isViewer ? (
    <span
      className="rounded-full px-1.5 py-0.5 text-[10px]"
      style={{
        backgroundColor: `${deal.stage.color}20`,
        color: deal.stage.color,
      }}
    >
      {deal.stage.name}
    </span>
  ) : (
    <DealStageSelect
      deal={deal}
      stages={
        stageGroups.find((g) => g.pipeline.id === deal.pipeline_id)
          ?.stages ?? []
      }
      onSelect={(stage) => handleMoveDeal(deal, stage)}
    />
  ))}
```

- [ ] **Step 4: Verificar**

Run: `npx tsc --noEmit && npx vitest run src/lib/pipelines/ && npx eslint src/components/inbox/deal-pipeline-controls.tsx src/components/inbox/contact-sidebar.tsx`
Expected: typecheck limpo, testes da Task 1 verdes, eslint sem erro novo.

Manual (app rodando, `npm run dev`): abrir uma conversa de contato com deal → o badge da fase vira botão com chevron; escolher outra fase move na hora; conferir no board que o card mudou de coluna; escolher a mesma fase não faz nada.

- [ ] **Step 5: Commit**

```bash
git add src/components/inbox/deal-pipeline-controls.tsx src/components/inbox/contact-sidebar.tsx messages/pt.json messages/en.json
git commit -m "feat: mover fase do negócio pela barra lateral do Inbox"
```

---

### Task 3: Criar negócio pelo Inbox ("Adicionar a um funil")

**Files:**
- Modify: `src/components/inbox/deal-pipeline-controls.tsx` (acrescenta `AddToPipelineMenu`)
- Modify: `src/components/inbox/contact-sidebar.tsx`
- Modify: `src/app/(dashboard)/inbox/page.tsx:664`
- Modify: `messages/pt.json`, `messages/en.json`

**Interfaces:**
- Consumes: `PipelineStageGroup` (Task 1); `DealStageSelect` já no arquivo (Task 2); `useAuth().defaultCurrency` (já exposto, `use-auth.tsx:359`).
- Produces: `AddToPipelineMenu({ groups, disabled, onSelect }: { groups: PipelineStageGroup[]; disabled?: boolean; onSelect: (pipelineId: string, stage: PipelineStage) => void })`; prop nova `conversationId?: string` em `ContactSidebarProps`.

- [ ] **Step 1: Acrescentar `AddToPipelineMenu` ao `deal-pipeline-controls.tsx`**

Imports adicionais no topo do arquivo:

```tsx
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import type { PipelineStageGroup } from "@/lib/pipelines/stage-groups";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
```

Componente novo, ao final do arquivo:

```tsx
/**
 * Ação de criar um negócio: fases agrupadas por funil — escolher a fase
 * determina o funil, sem conceito de "funil padrão". Não renderiza nada
 * quando não há fase alguma para escolher (conta sem funis).
 */
export function AddToPipelineMenu({
  groups,
  disabled,
  onSelect,
}: {
  groups: PipelineStageGroup[];
  disabled?: boolean;
  onSelect: (pipelineId: string, stage: PipelineStage) => void;
}) {
  const t = useTranslations("Inbox.sidebar");
  if (groups.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className="mt-2 w-full justify-start text-xs text-muted-foreground"
        >
          <Plus className="mr-1 h-3 w-3" />
          {t("addToPipeline")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
        {groups.map((group, index) => (
          <DropdownMenuGroup key={group.pipeline.id}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {group.pipeline.name}
            </DropdownMenuLabel>
            {group.stages.map((stage) => (
              <DropdownMenuItem
                key={stage.id}
                className="text-xs"
                onSelect={() => onSelect(group.pipeline.id, stage)}
              >
                <span
                  className="mr-2 h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: stage.color }}
                />
                {stage.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 2: i18n**

`messages/pt.json`, `Inbox.sidebar`:

```json
"addToPipeline": "Adicionar a um funil",
"toastCreateFailed": "Não foi possível criar o negócio"
```

`messages/en.json`, mesmo lugar:

```json
"addToPipeline": "Add to a pipeline",
"toastCreateFailed": "Could not create the deal"
```

- [ ] **Step 3: Prop `conversationId` e handler de criação no `contact-sidebar.tsx`**

3a. Props (linhas ~24-28):

```tsx
interface ContactSidebarProps {
  contact: Contact | null;
  /** Conversa aberta no Inbox — vinculada ao deal criado por aqui.
      Opcional: sem ela o deal nasce sem conversa, em vez de falhar. */
  conversationId?: string;
}

export function ContactSidebar({ contact, conversationId }: ContactSidebarProps) {
```

3b. Auth: incluir `defaultCurrency` (mesma linha da Task 2 step 3b):

```tsx
const { accountId, isViewer, defaultCurrency } = useAuth();
```

3c. Import do componente (ajustar a linha da Task 2):

```tsx
import {
  DealStageSelect,
  AddToPipelineMenu,
} from "@/components/inbox/deal-pipeline-controls";
```

3d. Estado + handler (depois de `handleMoveDeal`):

```tsx
const [creatingDeal, setCreatingDeal] = useState(false);

// Insert espelha deal-form.tsx:200 — user_id é NOT NULL desde a 001
// e status usa o literal "open" do formulário (o DEFAULT da coluna é
// 'active', divergência herdada do upstream).
const handleAddToPipeline = useCallback(
  async (pipelineId: string, stage: PipelineStage) => {
    if (!contact || !accountId) return;
    setCreatingDeal(true);
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setCreatingDeal(false);
      return;
    }
    const { data, error } = await supabase
      .from("deals")
      .insert({
        pipeline_id: pipelineId,
        stage_id: stage.id,
        contact_id: contact.id,
        conversation_id: conversationId ?? null,
        title: contact.name || contact.phone,
        value: 0,
        currency: defaultCurrency,
        status: "open",
        user_id: user.id,
        account_id: accountId,
      })
      .select("*, stage:pipeline_stages(*)")
      .single();
    if (error || !data) {
      toast.error(tSidebar("toastCreateFailed"));
    } else {
      setDeals((previous) => [data, ...previous]);
    }
    setCreatingDeal(false);
  },
  [contact, accountId, conversationId, defaultCurrency, tSidebar],
);
```

3e. Render — logo após o fechamento do bloco da lista de deals (`</div>` do `mt-2 space-y-2`, linha ~250), ainda dentro da seção "Active Deals":

```tsx
{!isViewer && (
  <AddToPipelineMenu
    groups={stageGroups}
    disabled={creatingDeal}
    onSelect={handleAddToPipeline}
  />
)}
```

- [ ] **Step 4: Passar a conversa ativa no Inbox**

`src/app/(dashboard)/inbox/page.tsx:664`:

```tsx
<ContactSidebar
  contact={activeContact}
  conversationId={activeConversation?.id}
/>
```

- [ ] **Step 5: Verificar**

Run: `npx tsc --noEmit && npx eslint src/components/inbox/deal-pipeline-controls.tsx src/components/inbox/contact-sidebar.tsx "src/app/(dashboard)/inbox/page.tsx"`
Expected: limpo.

Manual (app rodando): numa conversa de contato SEM deal → aparece "Adicionar a um funil"; escolher uma fase cria o card, que entra na lista sem recarregar; no board, o card está na fase certa, com título = nome do contato (ou telefone se sem nome), valor 0; abrir o deal e conferir a conversa vinculada. Logar como viewer → nem seletor nem ação aparecem.

- [ ] **Step 6: Commit**

```bash
git add src/components/inbox/deal-pipeline-controls.tsx src/components/inbox/contact-sidebar.tsx "src/app/(dashboard)/inbox/page.tsx" messages/pt.json messages/en.json
git commit -m "feat: criar negócio num funil direto pela barra lateral do Inbox"
```

---

### Task 4: Verificação final

**Files:** nenhum novo — só validação do conjunto.

- [ ] **Step 1: Suíte completa**

Run: `npx vitest run`
Expected: mesmas 2 falhas pré-existentes de `src/lib/dashboard/date-utils.test.ts` (fuso UTC-3, upstream — não são nossas); todo o resto verde, incluindo os 5 testes novos.

Run: `npx tsc --noEmit`
Expected: limpo.

- [ ] **Step 2: Fumaça com o Miguel (app rodando)**

- [ ] Mover deal pela barra lateral → coluna certa no board
- [ ] Mesma fase → nenhuma escrita (sem flicker, sem toast)
- [ ] Criar deal por "Adicionar a um funil" → card no board com conversa vinculada
- [ ] Contato sem nome → título do deal é o telefone
- [ ] Viewer não vê controles
- [ ] Derrubar a rede (DevTools offline) e mover → reverte com toast

- [ ] **Step 3: Release — SÓ com o OK do Miguel**

Convenção do produto (minor por deploy): bump `1.8.0 → 1.9.0` em `package.json`, entrada no `CHANGELOG.display4.md`, tag `v1.9.0`, commit `chore: v1.9.0 — fase do pipeline pela Caixa de Entrada`. **Não fazer push sem o Miguel mandar** — a Hostinger está saturada de processos e push dispara build nas branches implantadas.
