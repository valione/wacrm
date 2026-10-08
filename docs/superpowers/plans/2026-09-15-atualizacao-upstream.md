# Atualização do upstream — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trazer os 169 commits do upstream `ArnasDon/wacrm` para o fork sem perder as personalizações, e publicar nas três instalações sem quebrar produção.

**Architecture:** Um `git merge upstream/main` aberto no branch `atualizacao-upstream`, com os 20 conflitos reais resolvidos em camadas — migrações, backend crítico, telas, traduções, dependências — e commitado uma única vez ao final. As 6 migrações do upstream são renumeradas para 045–050 antes de qualquer aplicação em banco.

**Tech Stack:** Next.js 16, Supabase (Postgres), Vitest 4, next-intl, TypeScript.

Spec: `docs/superpowers/specs/2026-09-15-atualizacao-upstream-design.md`
Branch: `atualizacao-upstream` (já criado, a partir de `personalizacao-display4` `09db7c4`; HEAD atual `b5f3efe`).
Referência do upstream: `upstream/main` = `80c3f9a` (já buscada em `refs/remotes/upstream/main`).

## Global Constraints

- **O merge fica ABERTO da Task 2 até a Task 8.** Cada camada resolve seus arquivos e faz `git add`; o commit do merge acontece só na Task 8. Não usar `git commit` antes disso, e nunca `git merge --abort` depois da Task 2 sem falar com o usuário — abortar descarta todo o trabalho de resolução.
- **Nunca rodar `npm run format`, `prettier --write` no repo todo, nem `npm run lint --fix`.** O repositório tem dívida de formatação pré-existente (`format:check` falha em ~425 arquivos, `lint` emite 1 erro + 37 warnings). Formatar só o arquivo tocado, se necessário: `npx prettier --write <arquivo>`.
- **Armadilha do ambiente:** o repositório vive dentro do Google Drive, que altera timestamps durante a sincronização e faz o git falhar com `Entry '<arquivo>' not uptodate. Cannot merge.` Conserto: `git update-index --refresh` e repetir o comando.
- **Falhas de teste conhecidas e NÃO relacionadas:** 2 testes em `src/lib/dashboard/date-utils.test.ts` (mondayIndex) falham sempre nesta máquina por fuso UTC-3. São pré-existentes do upstream. Baseline antes do merge: **821 passando, 2 falhando, 823 total**.
- **Nenhuma migração é aplicada em banco neste plano até a Task 9.** Renumerar é mexer em arquivo; aplicar é mexer em produção.
- **As 6 migrações do upstream têm nomes distintos dos do fork**, então o git as adiciona sem conflito — o perigo é exatamente esse: sem renumerar, o repo fica com dois `037_*.sql`, dois `038_*.sql` etc., e os bancos (que já registraram `037`–`044` com o conteúdo do fork) tratariam as novas como aplicadas.
- Estilo do repo: aspas simples em `.ts`, `import { describe, expect, it } from 'vitest'`.

## Mapa dos 20 conflitos reais

Levantado por merge de teste em 2026-09-15 (número entre parênteses = marcadores `<<<<<<<`):

| Camada | Arquivos |
|---|---|
| 2 — WhatsApp (núcleo) | `src/app/api/whatsapp/webhook/route.ts` (6), `config/route.ts` (4), `react/route.ts` (2), `send/route.ts` (1), `src/lib/whatsapp/send-message.ts` (1) |
| 3 — Fluxos e automações | `src/lib/flows/meta-send.ts` (4), `src/lib/flows/engine.ts` (2), `src/lib/automations/meta-send.ts` (1), `src/app/api/automations/cron/route.ts` (1), `src/lib/automations/engine.test.ts` (2), `src/lib/flows/engine.test.ts` (1) |
| 4 — Telas | `src/app/(dashboard)/broadcasts/[id]/page.tsx` (5), `src/components/broadcasts/step4-schedule-send.tsx` (3), `src/components/inbox/message-thread.tsx` (2), `src/components/settings/whatsapp-config.tsx` (2), `src/app/(auth)/login/page.tsx` (1), `src/hooks/use-auth.tsx` (1) |
| 5 — Traduções | `messages/pt.json` (105), `messages/en.json` (6) |
| 6 — Dependências | `package-lock.json` (2) |

---

### Task 1: Rede de segurança — dumps dos três bancos

**Files:** nenhum no repositório. Produz 3 arquivos `.sql` fora do repo.

**Interfaces:**
- Consumes: nada.
- Produces: confirmação de que os dumps existem; nenhuma task seguinte lê os arquivos, mas a Task 9 não pode começar sem eles.

Esta task exige credenciais e **é executada junto com o usuário**. Não invente connection strings nem tente descobrir senhas no repositório.

- [ ] **Step 1: Confirmar o baseline verde**

Run: `npx vitest run`
Expected: `Tests 2 failed | 821 passed (823)` — as 2 falhas são as de `date-utils.test.ts` (mondayIndex). Qualquer outra falha significa que o ponto de partida já está quebrado: **pare e reporte**.

- [ ] **Step 2: Confirmar que o projeto da Anhembi não está pausado**

O plano free do Supabase pausa projetos após ~7 dias sem tráfego. Peça ao usuário o token `sbp_` da Management API (nunca grave o token em arquivo) e rode:

```bash
curl -s -H "Authorization: Bearer $SBP_TOKEN" \
  "https://api.supabase.com/v1/projects/mqfiqrrlarmuumwzbkid" | head -c 400
```

Expected: `"status":"ACTIVE_HEALTHY"`. Se vier `INACTIVE` ou a chamada devolver HTTP 544, restaure e espere alguns minutos:

```bash
curl -s -X POST -H "Authorization: Bearer $SBP_TOKEN" \
  "https://api.supabase.com/v1/projects/mqfiqrrlarmuumwzbkid/restore"
```

- [ ] **Step 3: Pedir ao usuário as connection strings e fazer os dumps**

Peça ao usuário as três connection strings (Supabase → Project Settings → Database → Connection string → URI). Para cada uma:

```bash
pg_dump "<CONNECTION_STRING>" --no-owner --no-acl \
  -f ~/Desktop/backup-wacrm-<instalacao>-2026-09-15.sql
```

Instalações e refs: Display4 `hhnmzwuuqyllydfdpmxs`, Campos Salles `gjdadqzwrdvjwrsdfaga`, Anhembi `mqfiqrrlarmuumwzbkid`.

- [ ] **Step 4: Verificar que os dumps têm conteúdo real**

```bash
for f in ~/Desktop/backup-wacrm-*-2026-09-15.sql; do
  echo "$f: $(wc -c < "$f") bytes, $(grep -c 'CREATE TABLE' "$f") tabelas"
done
```

Expected: cada arquivo com centenas de KB e ~38 tabelas. Um arquivo de poucos bytes significa dump falhado — **pare**.

- [ ] **Step 5: Reportar**

Não há commit nesta task. Reporte os três caminhos e tamanhos.

---

### Task 2: Abrir o merge e renumerar as migrações

**Files:**
- Renomeia: `supabase/migrations/037_webhook_broadcast_reliability.sql` → `045_webhook_broadcast_reliability.sql`
- Renomeia: `038_broadcast_resume.sql` → `046_broadcast_resume.sql`
- Renomeia: `039_inbound_media_mirror.sql` → `047_inbound_media_mirror.sql`
- Renomeia: `040_contact_business_scoped_user_id.sql` → `048_contact_business_scoped_user_id.sql`
- Renomeia: `041_fix_broadcast_contact_id_ambiguity.sql` → `049_fix_broadcast_contact_id_ambiguity.sql`
- Renomeia: `042_message_failure_reason.sql` → `050_message_failure_reason.sql`

**Interfaces:**
- Consumes: nada.
- Produces: o estado de merge aberto que todas as tasks 3–7 continuam; os nomes `045`–`050` que a Task 9 aplica nos bancos.

- [ ] **Step 1: Abrir o merge**

```bash
git merge --no-commit --no-ff upstream/main
```

Expected: termina com `Automatic merge failed; fix conflicts and then commit the result.` e **20** arquivos em conflito. Confirme:

```bash
git diff --name-only --diff-filter=U | wc -l
```
Expected: `20`. Se der outro número, o upstream mudou desde o levantamento — **pare e reporte**.

Se aparecer `Entry '<arquivo>' not uptodate. Cannot merge.`, rode `git update-index --refresh` e repita.

- [ ] **Step 2: Confirmar a duplicidade de numeração**

```bash
ls supabase/migrations/ | awk -F_ '{print $1}' | sort | uniq -d
```
Expected: `037 038 039 040 041 042` — seis números duplicados. É exatamente o problema que a renumeração resolve.

- [ ] **Step 3: Renomear as 6 do upstream**

```bash
cd supabase/migrations
git mv 037_webhook_broadcast_reliability.sql        045_webhook_broadcast_reliability.sql
git mv 038_broadcast_resume.sql                     046_broadcast_resume.sql
git mv 039_inbound_media_mirror.sql                 047_inbound_media_mirror.sql
git mv 040_contact_business_scoped_user_id.sql      048_contact_business_scoped_user_id.sql
git mv 041_fix_broadcast_contact_id_ambiguity.sql   049_fix_broadcast_contact_id_ambiguity.sql
git mv 042_message_failure_reason.sql               050_message_failure_reason.sql
cd ../..
```

- [ ] **Step 4: Verificar que não há mais duplicidade**

```bash
ls supabase/migrations/ | awk -F_ '{print $1}' | sort | uniq -d
```
Expected: saída vazia.

```bash
ls supabase/migrations/ | tail -8
```
Expected: `043_agent_signature_name.sql`, `044_delete_conversation.sql`, `045_webhook_broadcast_reliability.sql` … `050_message_failure_reason.sql`.

- [ ] **Step 5: Conferir que o conteúdo das migrações do fork não foi tocado**

```bash
git diff --cached --stat -- supabase/migrations/037_whatsapp_provider.sql supabase/migrations/044_delete_conversation.sql
```
Expected: saída vazia (as do fork não mudam).

- [ ] **Step 6: NÃO commitar**

O merge segue aberto. Reporte o estado: 20 conflitos pendentes, 6 migrações renomeadas.

---

### Task 3: Resolver os conflitos do núcleo do WhatsApp

**Files:**
- Modify: `src/app/api/whatsapp/webhook/route.ts` (6 conflitos)
- Modify: `src/app/api/whatsapp/config/route.ts` (4)
- Modify: `src/app/api/whatsapp/react/route.ts` (2)
- Modify: `src/app/api/whatsapp/send/route.ts` (1)
- Modify: `src/lib/whatsapp/send-message.ts` (1)

**Interfaces:**
- Consumes: o merge aberto da Task 2.
- Produces: esses 5 arquivos resolvidos e no index. A Task 4 depende de `sendMessageToConversation` (exportada em `src/lib/whatsapp/send-message.ts:182`) manter a assinatura que fluxos e automações chamam.

Esta é a camada mais perigosa: uma resolução errada aqui quebra o recebimento de mensagens sem erro visível no deploy.

**Regra de resolução (vale para os 5 arquivos):** o fork e o upstream mexeram em coisas diferentes do mesmo arquivo.

- **Do fork, preservar sempre:** o despacho por provedor (`meta` / `waha` / `uazapi`), o `getProvider`/`capabilities`, o gating por capacidade, o marcador `[ref:...]` de atribuição de site, a atribuição de marketing (CTWA/site/direto), a sincronização de status (`src/lib/whatsapp/status-sync.ts`), a assinatura do atendente e a exclusão de conversa.
- **Do upstream, adotar sempre:** a deduplicação de mensagens, o incremento atômico de não-lidas (`bump_conversation_on_inbound`), o espelhamento de mídia recebida, o BSUID (`wa_user_id`), o motivo de falha de envio (`message_failure_reason`) e o tratamento de erro de conexão.
- **Quando os dois mexeram na MESMA linha:** manter a estrutura do fork (que conhece provedores) e aplicar a melhoria do upstream dentro dela. Nunca descartar um provedor para fazer o upstream caber.
- Se um conflito não se encaixar em nenhuma dessas regras, **pare e pergunte** — não adivinhe.

- [ ] **Step 1: Ler cada conflito antes de editar**

```bash
git diff --diff-filter=U -- src/app/api/whatsapp/webhook/route.ts
```

Repita para os outros 4. Leia o arquivo inteiro em volta de cada marcador — os blocos `<<<<<<<`/`=======`/`>>>>>>>` escondem contexto importante.

- [ ] **Step 2: Resolver os 5 arquivos**

Aplique a regra acima. Ao terminar cada arquivo, confirme que não sobrou marcador:

```bash
grep -n "^<<<<<<<\|^=======\|^>>>>>>>" src/app/api/whatsapp/webhook/route.ts
```
Expected: saída vazia.

- [ ] **Step 3: Checar tipos**

Run: `npm run typecheck`
Expected: pode acusar erros vindos de arquivos ainda não resolvidos (fluxos, telas) — isso é esperado nesta altura. **Nenhum erro pode apontar para os 5 arquivos desta task.** Se apontar, corrija antes de seguir.

- [ ] **Step 4: Rodar os testes da área**

```bash
npx vitest run src/lib/whatsapp/
```
Expected: tudo passa. Se um teste do upstream falhar, leia-o: ele descreve o comportamento novo que a resolução precisa honrar.

- [ ] **Step 5: Marcar como resolvido**

```bash
git add src/app/api/whatsapp/webhook/route.ts src/app/api/whatsapp/config/route.ts \
        src/app/api/whatsapp/react/route.ts src/app/api/whatsapp/send/route.ts \
        src/lib/whatsapp/send-message.ts
```

Não commitar. Reporte quantos conflitos restam: `git diff --name-only --diff-filter=U | wc -l` (esperado: 15).

---

### Task 4: Resolver os conflitos de fluxos e automações

**Files:**
- Modify: `src/lib/flows/meta-send.ts` (4 conflitos)
- Modify: `src/lib/flows/engine.ts` (2)
- Modify: `src/lib/automations/meta-send.ts` (1)
- Modify: `src/app/api/automations/cron/route.ts` (1)
- Modify: `src/lib/automations/engine.test.ts` (2)
- Modify: `src/lib/flows/engine.test.ts` (1)

**Interfaces:**
- Consumes: o merge aberto; `sendWhatsAppMessage` já resolvido na Task 3.
- Produces: esses 6 arquivos resolvidos e no index.

**Regra de resolução:**

- **Do fork, preservar:** o gating por capacidade (`caps.supportsInteractive` em `src/lib/flows/meta-send.ts:357` e equivalentes) — é o que impede o CRM de tentar mandar botão por um provedor que não suporta; o nó `update_contact`; o `set_tag` despachando `runAutomationsForTrigger` com `run.vars`; o filtro de `trigger_config.tag_id`.
- **Do upstream, adotar:** a interpolação de `{{vars.*}}` em `send_buttons`/`send_list` (#553), o toque em botão disparando fluxo por palavra-chave (#490), as respostas de botão de template (#478) e o modo palavra-inteira nas automações por palavra-chave.
- **Nos dois arquivos de teste:** conflito em teste geralmente significa que os dois lados acrescentaram casos. Preserve **ambos os conjuntos** de casos, a menos que dois casos testem o mesmo comportamento com expectativas contraditórias — aí pare e pergunte.

- [ ] **Step 1: Ler cada conflito**

```bash
git diff --diff-filter=U -- src/lib/flows/meta-send.ts
```
Repita para os outros 5.

- [ ] **Step 2: Resolver os 6 arquivos**

Ao terminar cada um: `grep -n "^<<<<<<<\|^=======\|^>>>>>>>" <arquivo>` → saída vazia.

- [ ] **Step 3: Rodar os testes de fluxos e automações**

```bash
npx vitest run src/lib/flows/ src/lib/automations/
```
Expected: tudo passa, incluindo os casos novos vindos do upstream.

- [ ] **Step 4: Marcar como resolvido**

```bash
git add src/lib/flows/meta-send.ts src/lib/flows/engine.ts src/lib/automations/meta-send.ts \
        src/app/api/automations/cron/route.ts src/lib/automations/engine.test.ts \
        src/lib/flows/engine.test.ts
```

Reporte conflitos restantes (esperado: 9).

---

### Task 5: Resolver os conflitos de tela

**Files:**
- Modify: `src/app/(dashboard)/broadcasts/[id]/page.tsx` (5 conflitos)
- Modify: `src/components/broadcasts/step4-schedule-send.tsx` (3)
- Modify: `src/components/inbox/message-thread.tsx` (2)
- Modify: `src/components/settings/whatsapp-config.tsx` (2)
- Modify: `src/app/(auth)/login/page.tsx` (1)
- Modify: `src/hooks/use-auth.tsx` (1)

**Interfaces:**
- Consumes: o merge aberto.
- Produces: esses 6 arquivos resolvidos e no index.

**Regra de resolução:**

- **Do fork, preservar:** a marca (logo centralizado no login, `public/brand/*`, rodapé de propriedade), a UI de transmissões com texto livre e mídia, a tela de configuração dos provedores WAHA/Uazapi com QR, a exclusão de conversa com desfazer, a edição de contato pelo Inbox e os controles de fase do funil.
- **Do upstream, adotar:** o visualizador de mídia do Inbox, as notificações do navegador, o indicador de digitação da IA, a correção de retomada de transmissão e as melhorias de erro na conexão do WhatsApp.
- `src/components/settings/whatsapp-config.tsx` é o mais delicado: o fork adicionou o fluxo de QR code dos provedores não-Meta. **Nenhuma resolução pode remover a possibilidade de conectar por QR** — é como as três instalações funcionam hoje.

- [ ] **Step 1: Ler cada conflito**

```bash
git diff --diff-filter=U -- "src/app/(dashboard)/broadcasts/[id]/page.tsx"
```
Repita para os outros 5.

- [ ] **Step 2: Resolver os 6 arquivos**

Ao terminar cada um, confirme que não sobrou marcador.

**Armadilha de UI deste repo:** o dropdown é **base-ui** (`@base-ui/react/menu`), não Radix. `DropdownMenuItem` dispara `onClick` — `onSelect` é ignorado em silêncio e o TypeScript não acusa. `DropdownMenuTrigger` não aceita `asChild`. Se o upstream trouxer código com `onSelect` ou `asChild` em dropdown, converta.

- [ ] **Step 3: Checar tipos**

Run: `npm run typecheck`
Expected: agora só podem restar erros vindos de `messages/*.json` (Task 6) e dependências (Task 7). Nenhum erro nos arquivos desta task.

- [ ] **Step 4: Marcar como resolvido**

```bash
git add "src/app/(dashboard)/broadcasts/[id]/page.tsx" \
        src/components/broadcasts/step4-schedule-send.tsx \
        src/components/inbox/message-thread.tsx \
        src/components/settings/whatsapp-config.tsx \
        "src/app/(auth)/login/page.tsx" src/hooks/use-auth.tsx
```

Reporte conflitos restantes (esperado: 3).

---

### Task 6: Mesclar as traduções por script

**Files:**
- Create: `scripts/merge-messages.mjs`
- Modify: `messages/pt.json` (105 conflitos), `messages/en.json` (6)

**Interfaces:**
- Consumes: o merge aberto.
- Produces: `messages/pt.json` e `messages/en.json` resolvidos; `scripts/merge-messages.mjs` versionado para auditoria e reexecução.

**Decisão do usuário (do spec):** a tradução oficial do upstream é a base; as chaves que só existem no fork são reaplicadas por cima. Medido: upstream 1730 chaves, fork 1706, **281 só do fork**, 305 só do upstream. As 10 chaves usadas por `src/lib/vertical.ts` **existem** no `pt.json` oficial.

Resolver 105 marcadores à mão é inviável e propenso a erro. O script é a resolução.

- [ ] **Step 1: Escrever o script**

Criar `scripts/merge-messages.mjs`:

```js
#!/usr/bin/env node
/**
 * Mescla os dicionários de tradução durante o merge do upstream.
 *
 * Base: a versão do upstream (tradução oficial, decisão do Miguel em
 * 2026-09-15). Por cima, reaplica as chaves que só existem no fork — são
 * textos de funcionalidades que o upstream não tem (marketing, nova
 * conversa, excluir conversa, origem do contato). Sem isso, a interface
 * fica com buracos onde o dicionário não responde.
 *
 * Uso: node scripts/merge-messages.mjs <locale>
 * Lê as duas versões do git (estágios do merge) e escreve messages/<locale>.json.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const locale = process.argv[2]
if (!locale) {
  console.error('uso: node scripts/merge-messages.mjs <locale>')
  process.exit(2)
}

const ler = (ref) =>
  JSON.parse(execFileSync('git', ['show', `${ref}:messages/${locale}.json`], { encoding: 'utf8' }))

const fork = ler('HEAD')
const upstream = ler('MERGE_HEAD')

/** Achata em { 'A.B.c': 'texto' } para comparar chave a chave. */
function achatar(valor, prefixo = '', saida = {}) {
  if (typeof valor === 'string') {
    saida[prefixo] = valor
    return saida
  }
  if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      achatar(v, prefixo ? `${prefixo}.${k}` : k, saida)
    }
  }
  return saida
}

/** Grava 'A.B.c' num objeto aninhado, criando os níveis que faltarem. */
function gravar(obj, caminho, valor) {
  const partes = caminho.split('.')
  let cursor = obj
  for (let i = 0; i < partes.length - 1; i++) {
    if (typeof cursor[partes[i]] !== 'object' || cursor[partes[i]] === null) {
      cursor[partes[i]] = {}
    }
    cursor = cursor[partes[i]]
  }
  cursor[partes[partes.length - 1]] = valor
}

const planoFork = achatar(fork)
const planoUpstream = achatar(upstream)
const soDoFork = Object.keys(planoFork).filter((k) => !(k in planoUpstream))

const resultado = JSON.parse(JSON.stringify(upstream))
for (const caminho of soDoFork) {
  gravar(resultado, caminho, planoFork[caminho])
}

writeFileSync(`messages/${locale}.json`, JSON.stringify(resultado, null, 2) + '\n')

console.log(`${locale}: base upstream ${Object.keys(planoUpstream).length} chaves`)
console.log(`${locale}: reaplicadas do fork ${soDoFork.length} chaves`)
console.log(`${locale}: total ${Object.keys(achatar(resultado)).length} chaves`)
```

- [ ] **Step 2: Rodar para os dois idiomas**

O diretório `scripts/` ainda não existe neste repositório — crie-o junto com o arquivo (`mkdir -p scripts`).

```bash
node scripts/merge-messages.mjs pt
node scripts/merge-messages.mjs en
```

Expected para `pt`: `base upstream 1730 chaves`, `reaplicadas do fork 281 chaves`, `total 2011 chaves`. Se os números divergirem muito disso, **pare e reporte** — significa que o dicionário mudou desde o levantamento.

- [ ] **Step 3: Confirmar que não sobrou marcador de conflito**

```bash
grep -c "^<<<<<<<\|^=======\|^>>>>>>>" messages/pt.json messages/en.json
```
Expected: `0` nos dois (o script reescreve o arquivo inteiro, então os marcadores somem).

```bash
node -e "JSON.parse(require('fs').readFileSync('messages/pt.json')); JSON.parse(require('fs').readFileSync('messages/en.json')); console.log('JSON válido nos dois')"
```

- [ ] **Step 4: Confirmar que a vertical de educação sobreviveu**

Run: `npx vitest run src/lib/vertical.test.ts`
Expected: 14/14 passando. O teste `todo caminho trocado existe hoje em pt e en` é a prova de que as 10 chaves do "Curso de interesse" continuam no dicionário. **Se ele falhar, o upstream renomeou alguma chave** — reporte qual, com o nome antigo e o novo; a correção é atualizar a tabela em `src/lib/vertical.ts`, e isso precisa de aval do usuário porque muda texto que ele aprovou.

- [ ] **Step 5: Marcar como resolvido**

```bash
git add messages/pt.json messages/en.json scripts/merge-messages.mjs
```

Reporte conflitos restantes (esperado: 1).

---

### Task 7: Dependências e build

**Files:**
- Modify: `package-lock.json` (2 conflitos)

**Interfaces:**
- Consumes: o merge aberto, com todo o código já resolvido.
- Produces: `package-lock.json` coerente; build passando.

- [ ] **Step 1: Regenerar o lock em vez de resolver à mão**

Conflito em `package-lock.json` não se resolve editando. O arquivo é derivado — apague e regenere a partir do `package.json` já mesclado:

```bash
git checkout --theirs package-lock.json 2>/dev/null || true
rm -f package-lock.json
npm install
```

Expected: `npm install` termina sem erro e recria o arquivo.

- [ ] **Step 2: Conferir que o package.json mesclado não perdeu dependências do fork**

```bash
node -e '
const p = require("./package.json");
const precisa = ["next", "next-intl", "@supabase/supabase-js", "vitest"];
for (const d of precisa) {
  const v = p.dependencies?.[d] ?? p.devDependencies?.[d];
  console.log(d + ": " + (v ?? "AUSENTE"));
}'
```
Expected: nenhuma linha diz `AUSENTE`.

- [ ] **Step 3: Checar tipos**

Run: `npm run typecheck`
Expected: **limpo, sem nenhum erro.** Todos os arquivos já foram resolvidos. Erro aqui é resolução incorreta de alguma task anterior — corrija antes de seguir.

- [ ] **Step 4: Build de produção**

Run: `npm run build`
Expected: build conclui sem erro.

- [ ] **Step 5: Marcar como resolvido**

```bash
git add package-lock.json package.json
```

Reporte: `git diff --name-only --diff-filter=U | wc -l` deve ser `0`.

---

### Task 8: Fechar o merge

**Files:** nenhum novo — commita tudo que as tasks 2–7 deixaram no index.

**Interfaces:**
- Consumes: todos os conflitos resolvidos.
- Produces: o commit de merge; a partir daqui `atualizacao-upstream` contém `upstream/main`.

- [ ] **Step 1: Confirmar que não há conflito pendente**

```bash
git diff --name-only --diff-filter=U | wc -l
```
Expected: `0`.

```bash
grep -rn "^<<<<<<<\|^>>>>>>>" src/ messages/ supabase/ 2>/dev/null | head
```
Expected: saída vazia. Qualquer marcador remanescente é um arquivo mal resolvido.

- [ ] **Step 2: Rodar a suíte completa**

Run: `npx vitest run`
Expected: as 2 falhas conhecidas de `date-utils.test.ts` e **mais nada**. O total de testes será maior que 823, porque o upstream trouxe testes novos. Qualquer outra falha **bloqueia o commit** — investigue e corrija.

- [ ] **Step 3: Commitar o merge**

```bash
git commit --no-edit
```

Se o editor abrir, salve e feche. Depois confirme:

```bash
git log --oneline -1
git merge-base --is-ancestor upstream/main HEAD && echo "upstream incorporado"
```
Expected: a segunda linha imprime `upstream incorporado`.

- [ ] **Step 4: Registrar a renumeração no changelog**

Acrescentar ao topo de `CHANGELOG.display4.md`, abaixo do cabeçalho:

```markdown
## Atualização do upstream (2026-09-15)

Incorporado `ArnasDon/wacrm` até `80c3f9a` (169 commits). As migrações `037`–`042`
do upstream foram renumeradas para `045`–`050`: o fork já usava `037`–`044` com
conteúdo próprio, e os bancos das três instalações já as tinham registradas. Sem a
renumeração, o banco trataria as novas como aplicadas e o código quebraria em runtime.

Tradução: o `pt.json` oficial do upstream passou a ser a base, com as 281 chaves
exclusivas do fork reaplicadas por cima (`scripts/merge-messages.mjs`).
```

```bash
git add CHANGELOG.display4.md
git commit -m "docs: registrar a renumeração das migrações no changelog"
```

---

### Task 9: Verificação ao vivo e publicação escalonada

**Files:** nenhum. Esta task mexe em produção e **é executada junto com o usuário**.

**Interfaces:**
- Consumes: o merge fechado na Task 8; os dumps da Task 1.
- Produces: as três instalações atualizadas.

**Não comece esta task se a Task 1 não tiver produzido os três dumps.**

> ⚠️ **DEPENDÊNCIA DURA descoberta na revisão final — a ordem aqui não é preferência, é requisito.**
> Em cada instalação: aplicar **as seis migrações `045` a `050`, em ordem, todas antes**
> do `git push` daquela instalação. Nunca inverter, e nunca aplicar só um subconjunto.
>
> - `045` cria o índice único que o upsert de recebimento usa
>   (`onConflict: 'conversation_id,message_id'`). Sem ela, há fallback para insert
>   simples — a deduplicação fica inativa, mas a mensagem não se perde.
> - `047` (`messages.media_type`) e `048` (`contacts.wa_*`) **não têm fallback
>   nenhum**: sem `047` o insert de recebimento falha com `PGRST204` e toda
>   mensagem é descartada; sem `048` todo contato novo é descartado e todo envio
>   de fluxo/automação/IA falha. É por isso que essas duas são tão obrigatórias
>   quanto a `045`, mesmo não aparecendo em nenhum log de erro tratado.
> - `046`/`049` são necessárias para a criação de broadcast pela API v1.

- [ ] **Step 1: Teste ao vivo antes de qualquer publicação**

Subir local com as credenciais da Anhembi e verificar que mensagem real ainda chega e sai. Nenhum teste automático cobre isso, e o merge mexeu no webhook.

Peça ao usuário: número conectado e webhook apontando para o ambiente de teste. Roteiro mínimo:
1. Receber uma mensagem de fora → aparece no Inbox.
2. Responder pelo Inbox → chega no celular.
3. Conferir que o contador de não-lidas zera ao abrir a conversa.

Se qualquer passo falhar, **pare**: publicar quebraria o atendimento.

- [ ] **Step 2: Contar as duplicatas que a migração 045 apagaria — nos três bancos**

A `045_webhook_broadcast_reliability.sql` roda um `DELETE` em `messages`. Antes de aplicar, conte em cada banco (via SQL Editor do Supabase ou Management API):

```sql
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY conversation_id, message_id ORDER BY created_at ASC, id ASC
  ) AS rn
  FROM messages WHERE message_id IS NOT NULL
)
SELECT count(*) FROM ranked WHERE rn > 1;
```

Expected: `0`. **Se vier diferente de zero em qualquer banco, PARE** e mostre ao usuário quantas linhas e de quais conversas, antes de aplicar. Mensagem de cliente apagada não volta.

- [ ] **Step 3: Publicar na Anhembi Morumbi (cobaia)**

Aplicar as migrações `045`–`050` no projeto `mqfiqrrlarmuumwzbkid`, em ordem, via Management API (token `sbp_` pedido ao usuário na hora, nunca gravado), registrando cada uma:

```sql
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('045', '045_webhook_broadcast_reliability');
```

(idem para 046–050, com os respectivos nomes)

Depois:

```bash
git checkout anhembi-morumbi
git merge atualizacao-upstream
npx vitest run
git push origin anhembi-morumbi
```

Aguardar o deploy (~90s) e verificar: login abre, Inbox carrega, marca da Anhembi no lugar, campo "Curso de interesse" presente.

- [ ] **Step 4: Observar antes de seguir**

Aguardar confirmação do usuário de que a Anhembi está funcionando. **Não publique nas outras duas no mesmo impulso** — o objetivo de escalonar é justamente ter tempo de perceber um problema.

- [ ] **Step 5: Publicar na Display4**

Mesmo procedimento, projeto `hhnmzwuuqyllydfdpmxs`, branch `personalizacao-display4`. Atenção: este branch é o do produto — publique-o **antes** de fazer o merge em `campos-salles`, para que a CS receba a mesma base já validada.

- [ ] **Step 6: Publicar na Campos Salles (cliente pagante, por último)**

Mesmo procedimento, projeto `gjdadqzwrdvjwrsdfaga`, branch `campos-salles`. Verificar marca da CS, campo "Curso de interesse" e envio de mensagem real.

- [ ] **Step 7: Reportar o estado final**

Listar, para cada instalação: commit publicado, migrações aplicadas e resultado da verificação.

---

### Task 10: Portar as melhorias de recebimento para `inbound.ts`

**Executar logo após a Task 4** (não no fim). A Task 4 resolve `src/lib/automations/meta-send.ts`, e enquanto esse arquivo tiver marcadores de conflito a suíte de `webhook/route.test.ts` não carrega — sem ela, esta task ficaria sem rede de segurança.

**Files:**
- Modify: `src/lib/whatsapp/inbound.ts` (749 linhas, exclusivo do fork)
- Test: `src/app/api/whatsapp/webhook/route.test.ts` (já existe, vindo do upstream)

**Interfaces:**
- Consumes: os cinco arquivos resolvidos na Task 3; `meta-send.ts` resolvido na Task 4.
- Produces: `inbound.ts` com o comportamento do upstream; nenhuma assinatura nova.

**Por que esta task existe (lacuna encontrada durante a Task 3):** o fork extraiu o pipeline de persistência do webhook para `src/lib/whatsapp/inbound.ts`, compartilhado pelos webhooks Meta, WAHA e Uazapi. O upstream manteve esse código dentro de `src/app/api/whatsapp/webhook/route.ts` e foi **lá** que aplicou suas melhorias. Como os dois lados editaram arquivos diferentes, **o git não gera conflito** — as melhorias entrariam no repositório sem nunca alcançar o código que as três instalações realmente executam. O plano original não previu isso.

**A especificação desta task são os 18 testes que falham** em `src/app/api/whatsapp/webhook/route.test.ts`. Eles vieram do upstream e descrevem exatamente o comportamento a portar. Causa raiz única hoje: `.from(...).insert is not a function` em `inbound.ts`.

Itens a portar (todos do "adotar sempre" do spec):

1. **Deduplicação de mensagens recebidas** por `(conversation_id, message_id)` (upstream #367). A migração `045` cria o índice único que a sustenta.
2. **Incremento atômico de não-lidas** via a função `bump_conversation_on_inbound` (upstream #369), no lugar do ler-modificar-gravar. Sem isso, duas mensagens que chegam juntas perdem uma contagem.
3. **Reabertura de conversa fechada** ao chegar mensagem, e gravação de `media_type`.
4. **BSUID** (`wa_user_id`, `wa_parent_user_id`, `wa_username`) na identificação do contato (upstream #519). As colunas vêm da migração `048`.

**Regressão temporária a corrigir aqui:** a Task 3 passou a descartar, com log de erro, entrega da Meta sem telefone (remetente identificado só por BSUID), em vez de criar contato com `phone: ''`. Ao portar o item 4, restaure o caminho correto: identificar o contato pelo BSUID. Isso não afeta as instalações hoje (as três rodam `uazapi`), mas deixa o caminho Meta correto.

- [ ] **Step 1: Ver o que os testes exigem**

```bash
npx vitest run src/app/api/whatsapp/webhook
```
Expected no início: 18 falhando, 12 passando. Leia as 18 mensagens — elas são os requisitos.

- [ ] **Step 2: Ler as duas implementações lado a lado**

```bash
git show upstream/main:src/app/api/whatsapp/webhook/route.ts > /tmp/webhook-upstream.ts
```

Compare com `src/lib/whatsapp/inbound.ts`. O upstream é Meta-only; `inbound.ts` atende os três provedores. **Porte o comportamento, não o código** — copiar trechos Meta-only quebraria WAHA e Uazapi, que é como as três instalações funcionam.

- [ ] **Step 3: Portar os quatro itens**

Preserve o que é do fork: atribuição de marketing (CTWA / site via `[ref:]` / direto), download de mídia da Uazapi via `POST /message/download`, o `site_ref` de primeiro toque, e o despacho por provedor.

- [ ] **Step 4: Rodar os testes até ficarem verdes**

```bash
npx vitest run src/app/api/whatsapp/webhook
```
Expected: 30/30 passando.

- [ ] **Step 5: Confirmar que os outros provedores não quebraram**

```bash
npx vitest run src/lib/whatsapp/
```
Expected: tudo passa (444 testes no último levantamento, mais os que a Task 4 destravar).

- [ ] **Step 6: Marcar como resolvido**

```bash
git add src/lib/whatsapp/inbound.ts
```

Sem commit — o merge segue aberto até a Task 8.

**Dois achados da revisão da Task 3 que pertencem a esta task** (ambos dormentes hoje, reativados exatamente quando o item 4 acima passar a gravar `wa_user_id`):

5. **`src/lib/whatsapp/send-message.ts:242-254` — falta a guarda de BSUID que o `/react` tem.** Se um contato tiver `wa_user_id` mas nenhum telefone válido numa conta `uazapi`/`waha`, `resolveContactSendTarget` devolve o BSUID e ele é entregue a `provider.sendText({ to })` como se fosse telefone — resultando em 502 com erro opaco do provedor, em vez do 422 `unsupported_by_provider` que `react/route.ts:128-141` devolve na mesma situação. Espelhe a guarda do `/react`.
6. **`src/app/api/whatsapp/webhook/route.ts:497` — a guarda de descarte lê apenas `message.from`.** O `resolveInboundIdentity` do upstream (`wa-identity.ts:110`) também considera `contact?.wa_id`, então uma entrega da Meta que traga o número apenas na entrada `contacts[]` é descartada embora seja processável. Corrija para considerar as duas origens.
