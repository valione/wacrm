# Campo "Curso de interesse" — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nas instalações de educação, o campo **Empresa** do contato passa a se chamar **Curso de interesse**, ligado por uma variável de ambiente por instalação, sem tocar em banco nem em componente.

**Architecture:** Um módulo puro (`src/lib/vertical.ts`) guarda a tabela de rótulos por vertical e locale. `src/i18n/request.ts` — ponto único por onde o dicionário passa para servidor e navegador — aplica essa tabela ao carregar as mensagens. Nenhum dos seis componentes que exibem o campo é editado, porque o rótulo precisa variar por instalação a partir do mesmo código.

**Tech Stack:** Next.js 16.2.6, next-intl, TypeScript, Vitest 4 (`environment: node`).

Spec: `docs/superpowers/specs/2026-08-18-campo-curso-interesse-design.md`
Branch: `campo-curso-interesse` (já criado a partir de `personalizacao-display4`).

## Global Constraints

- **Sem migração de banco.** A coluna continua `contacts.company`. Nenhuma task altera SQL.
- **Display4 intocada.** Com `NEXT_PUBLIC_VERTICAL` vazia, o dicionário devolvido tem de ser o **mesmo objeto** recebido (identidade, não cópia igual).
- **Nenhum componente editado.** Não alterar `contacts/page.tsx`, `contact-form.tsx`, `contact-detail-view.tsx`, `conversation-list.tsx`, `automation-builder.tsx`, `node-config-form.tsx`.
- **Dois textos ficam fora e não podem mudar:** `Settings.profile.signatureHint` e `Settings.aiConfig.promptPlaceholder` — citam "empresa"/"Acme" sem relação com o campo do contato.
- **Envs (literais, nunca dinâmicas).** `NEXT_PUBLIC_VERTICAL` e `NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE` devem aparecer escritas por extenso no código (`process.env.NEXT_PUBLIC_VERTICAL`), porque o Next inlina no build por substituição textual — `process.env[nome]` não funciona.
- **Rodar testes com `npx vitest run <arquivo>`.** Dois testes de `src/lib/dashboard/date-utils.test.ts` (mondayIndex) falham sempre nesta máquina (UTC-3); são pré-existentes do upstream e **não** indicam regressão.
- Estilo do repo: aspas simples, sem ponto e vírgula obrigatório, `import { describe, expect, it } from 'vitest'`.

---

### Task 1: Módulo de rótulos por vertical

**Files:**
- Create: `src/lib/vertical.ts`
- Test: `src/lib/vertical.test.ts`

**Interfaces:**
- Consumes: nada (primeira task).
- Produces: `applyVerticalLabels<T extends object>(messages: T, locale: string, options?: VerticalOptions): T` e `interface VerticalOptions { vertical?: string; fieldExample?: string }`. A Task 2 consome exatamente essa assinatura.

- [ ] **Step 1: Escrever os testes que falham**

Criar `src/lib/vertical.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import ptMessages from '../../messages/pt.json'
import enMessages from '../../messages/en.json'
import { applyVerticalLabels } from './vertical'

/** Achata o dicionário em { 'A.B.c': 'texto' } para comparar chave a chave. */
function flatten(
  value: unknown,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  if (typeof value === 'string') {
    out[prefix] = value
    return out
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out)
    }
  }
  return out
}

/** Caminhos que a vertical `educacao` troca, fora o exemplo do campo. */
const CAMINHOS_TROCADOS = [
  'Contacts.form.companyLabel',
  'Contacts.detailView.company',
  'Contacts.page.tableColumns.company',
  'Contacts.importModal.columns.company',
  'Contacts.importModal.desc',
  'Inbox.conversationList.company',
  'Inbox.conversationList.allCompanies',
  'Automations.builder.fields.company',
  'Automations.builder.config.placeholderContact',
  'Flows.builder.form.varKeyPlaceholder',
]

const EXEMPLO_DO_CAMPO = 'Contacts.form.companyPlaceholder'

describe('applyVerticalLabels — sem vertical', () => {
  it('devolve o mesmo objeto quando a vertical está vazia', () => {
    const out = applyVerticalLabels(ptMessages, 'pt', { vertical: '' })
    expect(out).toBe(ptMessages)
  })

  it('devolve o mesmo objeto quando a vertical é desconhecida', () => {
    const out = applyVerticalLabels(ptMessages, 'pt', { vertical: 'imobiliaria' })
    expect(out).toBe(ptMessages)
  })

  it('devolve o mesmo objeto quando o locale não tem tabela', () => {
    const out = applyVerticalLabels(ptMessages, 'fr', { vertical: 'educacao' })
    expect(out).toBe(ptMessages)
  })
})

describe('applyVerticalLabels — educacao/pt', () => {
  const out = applyVerticalLabels(ptMessages, 'pt', {
    vertical: 'educacao',
    fieldExample: 'Direito',
  })
  const antes = flatten(ptMessages)
  const depois = flatten(out)

  it('renomeia o campo no formulário, na ficha e na tabela', () => {
    expect(depois['Contacts.form.companyLabel']).toBe('Curso de interesse')
    expect(depois['Contacts.detailView.company']).toBe('Curso de interesse')
    expect(depois['Contacts.page.tableColumns.company']).toBe('Curso de interesse')
  })

  it('usa singular curto no filtro do Inbox e plural correto no "todos"', () => {
    expect(depois['Inbox.conversationList.company']).toBe('Curso')
    expect(depois['Inbox.conversationList.allCompanies']).toBe('Todos os cursos')
  })

  it('usa o exemplo da instalação dentro do campo', () => {
    expect(depois[EXEMPLO_DO_CAMPO]).toBe('Direito')
  })

  it('cai no exemplo padrão quando a instalação não define um', () => {
    const semExemplo = applyVerticalLabels(ptMessages, 'pt', {
      vertical: 'educacao',
      fieldExample: '',
    })
    expect(flatten(semExemplo)[EXEMPLO_DO_CAMPO]).toBe('Administração')
  })

  it('manda o CSV citar a coluna curso', () => {
    expect(depois['Contacts.importModal.desc']).toContain('<companyCode>curso</companyCode>')
    expect(depois['Contacts.importModal.desc']).not.toContain('<companyCode>company</companyCode>')
  })

  it('não muda nenhuma chave além das previstas', () => {
    const previstas = new Set([...CAMINHOS_TROCADOS, EXEMPLO_DO_CAMPO])
    const diferentes = Object.keys(antes).filter((k) => antes[k] !== depois[k])
    expect(diferentes.sort()).toEqual([...previstas].sort())
  })

  it('não cria nem remove chaves', () => {
    expect(Object.keys(depois).sort()).toEqual(Object.keys(antes).sort())
  })

  it('preserva os dois textos que citam empresa por coincidência', () => {
    expect(depois['Settings.profile.signatureHint']).toBe(
      antes['Settings.profile.signatureHint'],
    )
    expect(depois['Settings.aiConfig.promptPlaceholder']).toBe(
      antes['Settings.aiConfig.promptPlaceholder'],
    )
  })

  it('não muta o dicionário original', () => {
    expect(flatten(ptMessages)['Contacts.form.companyLabel']).toBe('Empresa')
  })
})

describe('applyVerticalLabels — educacao/en', () => {
  it('traduz os rótulos equivalentes', () => {
    const out = flatten(
      applyVerticalLabels(enMessages, 'en', { vertical: 'educacao', fieldExample: '' }),
    )
    expect(out['Contacts.form.companyLabel']).toBe('Course of interest')
    expect(out['Inbox.conversationList.allCompanies']).toBe('All courses')
  })
})

describe('tabela de rótulos vs. dicionário real', () => {
  it('todo caminho trocado existe hoje em pt e en', () => {
    for (const caminho of [...CAMINHOS_TROCADOS, EXEMPLO_DO_CAMPO]) {
      expect(flatten(ptMessages)[caminho], `pt: ${caminho}`).toBeTypeOf('string')
      expect(flatten(enMessages)[caminho], `en: ${caminho}`).toBeTypeOf('string')
    }
  })
})
```

Este último bloco é a rede de segurança contra o upstream: se o ArnasDon renomear uma chave, o teste quebra em vez de o rótulo sumir em silêncio.

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/vertical.test.ts`
Expected: FAIL — `Failed to resolve import "./vertical"`.

- [ ] **Step 3: Escrever o módulo**

Criar `src/lib/vertical.ts`:

```ts
/**
 * Rótulos por vertical de mercado. O produto é um só e as instalações
 * compilam do mesmo código, então textos que mudam por cliente não podem
 * viver dentro do componente — vêm daqui, ligados por env.
 *
 * Hoje só existe a vertical `educacao`, que troca "Empresa" por "Curso de
 * interesse" no contato (Campos Salles, Anhembi Morumbi). Instalação sem
 * NEXT_PUBLIC_VERTICAL (Display4) recebe o dicionário intacto.
 *
 * NEXT_PUBLIC_* é inlinado no BUILD por substituição textual — as duas envs
 * são lidas por extenso, nunca por índice dinâmico.
 */

export interface VerticalOptions {
  /** Sobrepõe NEXT_PUBLIC_VERTICAL (usado nos testes). */
  vertical?: string
  /** Sobrepõe NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE (usado nos testes). */
  fieldExample?: string
}

type TabelaDeRotulos = Record<string, string>

/** Chave do exemplo que aparece dentro do campo — valor vem da instalação. */
const EXEMPLO_DO_CAMPO = 'Contacts.form.companyPlaceholder'

const EDUCACAO_PT: TabelaDeRotulos = {
  'Contacts.form.companyLabel': 'Curso de interesse',
  'Contacts.detailView.company': 'Curso de interesse',
  'Contacts.page.tableColumns.company': 'Curso de interesse',
  'Contacts.importModal.columns.company': 'Curso de interesse',
  'Contacts.importModal.desc':
    'Envie um CSV com a coluna obrigatória <phoneCode>phone</phoneCode>. Opcionais: <nameCode>name</nameCode>, <emailCode>email</emailCode>, <companyCode>curso</companyCode>, <tagsCode>tags</tagsCode> (separadas por vírgula; use aspas em células com várias tags).',
  'Inbox.conversationList.company': 'Curso',
  'Inbox.conversationList.allCompanies': 'Todos os cursos',
  'Automations.builder.fields.company': 'Curso de interesse',
  'Automations.builder.config.placeholderContact': 'nome / e-mail / curso',
  'Flows.builder.form.varKeyPlaceholder': 'ex.: nome, email, curso',
}

const EDUCACAO_EN: TabelaDeRotulos = {
  'Contacts.form.companyLabel': 'Course of interest',
  'Contacts.detailView.company': 'Course of interest',
  'Contacts.page.tableColumns.company': 'Course of interest',
  'Contacts.importModal.columns.company': 'Course of interest',
  'Contacts.importModal.desc':
    'Upload a CSV with a required <phoneCode>phone</phoneCode> column. Optional: <nameCode>name</nameCode>, <emailCode>email</emailCode>, <companyCode>course</companyCode>, <tagsCode>tags</tagsCode> (comma-separated; quote multi-tag cells).',
  'Inbox.conversationList.company': 'Course',
  'Inbox.conversationList.allCompanies': 'All courses',
  'Automations.builder.fields.company': 'Course of interest',
  'Automations.builder.config.placeholderContact': 'name / email / course',
  'Flows.builder.form.varKeyPlaceholder': 'e.g. name, email, course',
}

const TABELAS: Record<string, Record<string, TabelaDeRotulos>> = {
  educacao: { pt: EDUCACAO_PT, en: EDUCACAO_EN },
}

/** Exemplo usado quando a instalação não define o seu. */
const EXEMPLO_PADRAO: Record<string, Record<string, string>> = {
  educacao: { pt: 'Administração', en: 'Business Administration' },
}

/**
 * Grava `valor` em `caminho` devolvendo uma cópia — clona só os níveis do
 * caminho (o resto do dicionário é compartilhado). Caminho inexistente
 * devolve o objeto original: se o upstream renomear a chave, o rótulo deixa
 * de ser trocado em vez de nascer uma chave fantasma. O teste
 * "todo caminho trocado existe hoje" avisa quando isso acontecer.
 */
function gravarCaminho<T extends object>(obj: T, caminho: string, valor: string): T {
  const partes = caminho.split('.')
  const raiz: Record<string, unknown> = { ...obj }
  let cursor = raiz

  for (let i = 0; i < partes.length - 1; i++) {
    const filho = cursor[partes[i]]
    if (!filho || typeof filho !== 'object') return obj
    const copia = { ...(filho as Record<string, unknown>) }
    cursor[partes[i]] = copia
    cursor = copia
  }

  const folha = partes[partes.length - 1]
  if (typeof cursor[folha] !== 'string') return obj
  cursor[folha] = valor
  return raiz as T
}

export function applyVerticalLabels<T extends object>(
  messages: T,
  locale: string,
  options: VerticalOptions = {},
): T {
  const vertical = (options.vertical ?? process.env.NEXT_PUBLIC_VERTICAL ?? '').trim()
  if (!vertical) return messages

  const tabela = TABELAS[vertical]?.[locale]
  if (!tabela) return messages

  let resultado = messages
  for (const [caminho, valor] of Object.entries(tabela)) {
    resultado = gravarCaminho(resultado, caminho, valor)
  }

  const exemplo =
    (options.fieldExample ?? process.env.NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE ?? '').trim() ||
    EXEMPLO_PADRAO[vertical]?.[locale]
  if (exemplo) {
    resultado = gravarCaminho(resultado, EXEMPLO_DO_CAMPO, exemplo)
  }

  return resultado
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/vertical.test.ts`
Expected: PASS — 14 testes.

- [ ] **Step 5: Checar tipos**

Run: `npm run typecheck`
Expected: sem erros. (`resolveJsonModule` e `esModuleInterop` já estão ligados no `tsconfig.json`, e o import de `.json` dentro de teste foi verificado nesta base — não precisa de configuração nova.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/vertical.ts src/lib/vertical.test.ts
git commit -m "feat: tabela de rótulos por vertical de mercado"
```

---

### Task 2: Ligar a tabela no carregamento do dicionário

**Files:**
- Modify: `src/i18n/request.ts`

**Interfaces:**
- Consumes: `applyVerticalLabels(messages, locale, options?)` da Task 1.
- Produces: nada para tasks seguintes — é a ponta que faz o rótulo chegar à tela.

Sem teste automático nesta task: o arquivo é cola de três linhas em volta do `getRequestConfig` do next-intl, e um teste que finge o contrato interno dessa função quebraria em upgrade da lib sem nenhum bug real existir. A lógica toda está coberta na Task 1; aqui a verificação é typecheck, build e conferência na tela.

- [ ] **Step 1: Editar o arquivo**

`src/i18n/request.ts` fica assim (as duas linhas novas estão marcadas):

```ts
import { getRequestConfig } from 'next-intl/server';
import { applyVerticalLabels } from '@/lib/vertical'; // novo

export default getRequestConfig(async () => {
  // Read the locale from the environment, defaulting to 'en'
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'en';

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch (error) {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages: applyVerticalLabels(messages, locale), // novo
  };
});
```

- [ ] **Step 2: Checar tipos e lint**

Run: `npm run typecheck && npm run lint`
Expected: sem erros.

- [ ] **Step 3: Conferir na tela, com a vertical DESLIGADA**

```bash
npm run dev
```

Abrir `http://localhost:3000` → Contatos → Novo contato.
Expected: o campo ainda se chama **Empresa**, com exemplo **Acme Corp**. (Este é o teste de que a Display4 não muda.)

- [ ] **Step 4: Conferir na tela, com a vertical LIGADA**

Parar o dev, subir de novo com as envs:

```bash
NEXT_PUBLIC_VERTICAL=educacao NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE=Direito npm run dev
```

Conferir os quatro pontos:
1. Contatos → Novo contato → campo **Curso de interesse**, exemplo **Direito**.
2. Contatos → a coluna da tabela diz **Curso de interesse**.
3. Inbox → filtro diz **Curso** e a opção "todos" diz **Todos os cursos**.
4. Configurações → Seu perfil → a dica da assinatura continua falando "nome da empresa" (é do WhatsApp, não do campo).

- [ ] **Step 5: Build de produção**

Run: `npm run build`
Expected: build conclui sem erro.

- [ ] **Step 6: Commit**

```bash
git add src/i18n/request.ts
git commit -m "feat: aplicar rótulos da vertical ao carregar o dicionário"
```

---

### Task 3: Importação de CSV aceita a coluna `curso`

**Files:**
- Modify: `src/lib/contacts/parse-contact-csv.ts:59`
- Test: `src/lib/contacts/parse-contact-csv.test.ts`

**Interfaces:**
- Consumes: nada das tasks anteriores.
- Produces: nenhuma assinatura nova — `parseContactCsv(text)` e `ParseContactCsvResult` seguem iguais, inclusive o campo `hasCompanyColumn`, que `import-modal.tsx:380` usa para decidir se mostra a coluna na prévia.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar ao fim de `src/lib/contacts/parse-contact-csv.test.ts`, dentro do `describe('parseContactCsv', ...)` existente:

```ts
  it('aceita a coluna curso como sinônimo de company', () => {
    const csv = `phone,name,curso
+15551234567,Alice,Direito`

    const result = parseContactCsv(csv)
    expect(result.hasCompanyColumn).toBe(true)
    expect(result.rows[0].company).toBe('Direito')
  })

  it('continua aceitando a coluna company', () => {
    const csv = `phone,name,company
+15551234567,Alice,Acme Corp`

    const result = parseContactCsv(csv)
    expect(result.hasCompanyColumn).toBe(true)
    expect(result.rows[0].company).toBe('Acme Corp')
  })

  it('prefere company quando as duas colunas existem', () => {
    const csv = `phone,company,curso
+15551234567,Acme Corp,Direito`

    expect(parseContactCsv(csv).rows[0].company).toBe('Acme Corp')
  })
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `npx vitest run src/lib/contacts/parse-contact-csv.test.ts`
Expected: FAIL no primeiro teste — `hasCompanyColumn` vem `false` e `company` vem `undefined`.

- [ ] **Step 3: Implementar**

Em `src/lib/contacts/parse-contact-csv.ts`, trocar a linha 59:

```ts
  const companyIdx = headers.indexOf('company');
```

por:

```ts
  // `curso` é o cabeçalho das instalações de educação, onde o campo se
  // chama "Curso de interesse" (ver src/lib/vertical.ts). `company` vem
  // primeiro para não mudar o resultado de planilhas antigas.
  const companyIdx =
    headers.indexOf('company') >= 0
      ? headers.indexOf('company')
      : headers.indexOf('curso');
```

- [ ] **Step 4: Rodar e ver passar**

Run: `npx vitest run src/lib/contacts/parse-contact-csv.test.ts`
Expected: PASS — os testes antigos e os três novos.

- [ ] **Step 5: Rodar a suíte inteira**

Run: `npx vitest run`
Expected: tudo passa, exceto os dois testes de `date-utils.test.ts` (mondayIndex), que falham nesta máquina por fuso e são pré-existentes do upstream.

- [ ] **Step 6: Commit**

```bash
git add src/lib/contacts/parse-contact-csv.ts src/lib/contacts/parse-contact-csv.test.ts
git commit -m "feat: importação de contatos aceita a coluna curso"
```

---

### Task 4: Documentar as duas variáveis

**Files:**
- Modify: `docs/nova-instalacao.md:86`
- Modify: `.env.local.example:46`

**Interfaces:**
- Consumes: os nomes `NEXT_PUBLIC_VERTICAL` e `NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE` da Task 1.
- Produces: nada.

- [ ] **Step 1: Runbook de nova instalação**

Em `docs/nova-instalacao.md`, no bloco de variáveis do passo 5, acrescentar as duas linhas logo abaixo de `NEXT_PUBLIC_APP_NAME=ClienteX | CRM`:

```
NEXT_PUBLIC_VERTICAL=
NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE=
```

E, nas "Notas de marca" (por volta da linha 62), acrescentar um item:

```markdown
- Instituição de ensino: `NEXT_PUBLIC_VERTICAL=educacao` renomeia o campo
  Empresa do contato para "Curso de interesse" em toda a interface, e
  `NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE` é o exemplo mostrado dentro do campo
  (Campos Salles usa `Direito`; Anhembi Morumbi, `Publicidade e Propaganda`).
  Deixar as duas em branco mantém "Empresa". A importação de CSV passa a
  aceitar o cabeçalho `curso` além de `company`.
```

- [ ] **Step 2: Env de exemplo**

Em `.env.local.example`, abaixo da linha `NEXT_PUBLIC_APP_LOCALE=en`, acrescentar:

```
# Vertical de mercado da instalação. Vazio = produto padrão ("Empresa" no
# contato). `educacao` renomeia esse campo para "Curso de interesse".
NEXT_PUBLIC_VERTICAL=
# Exemplo mostrado dentro do campo — só usado quando há vertical.
# Ex.: Direito (Campos Salles), Publicidade e Propaganda (Anhembi Morumbi).
NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE=
```

- [ ] **Step 3: Conferir que nada mais quebrou**

Run: `npm run format:check`
Expected: sem erro de formatação nos arquivos tocados. (Se acusar, rodar `npm run format` e conferir o diff.)

- [ ] **Step 4: Commit**

```bash
git add docs/nova-instalacao.md .env.local.example
git commit -m "docs: variáveis da vertical de educação"
```

---

## Depois do plano (fora do escopo das tasks, é operação do Miguel)

1. Revisão do trabalho e merge de `campo-curso-interesse` em `personalizacao-display4`.
2. Levar às instalações: `git checkout campos-salles && git merge personalizacao-display4 && git push`, idem para `anhembi-morumbi`.
3. Na Hostinger, em cada app, definir as duas envs e **reimplantar** — `NEXT_PUBLIC_*` é inlinado no build, então trocar a variável sem reimplantar não muda nada (lição já registrada).

| Instalação | `NEXT_PUBLIC_VERTICAL` | `NEXT_PUBLIC_CONTACT_FIELD_EXAMPLE` |
|---|---|---|
| Display4 | *(vazio)* | *(vazio)* |
| Campos Salles | `educacao` | `Direito` |
| Anhembi Morumbi | `educacao` | `Publicidade e Propaganda` |
