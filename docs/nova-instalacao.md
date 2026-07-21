# Runbook — nova instalação para um cliente

Modelo: **um produto, N instalações**. Cada cliente tem branch própria
(produto + 1 commit de marca), Supabase próprio, app próprio no Hostinger,
domínio próprio e chaves próprias. A Valione administra todas.

Tempo estimado: ~1h. Referência viva: a instalação da Display4
(branch `personalizacao-display4`, https://crm.display4.com.br).

## 0. Insumos do cliente (antes de começar)

- [ ] Nome do app (ex.: `ClienteX | CRM`)
- [ ] Logo e ícone (vetor SVG/AI ideal; senão PNG grande — dá para extrair
      de um PDF com o logo embutido, como feito com a Display4)
- [ ] Domínio/subdomínio (ex.: `crm.clientex.com.br`) com DNS acessível
- [ ] Número de WhatsApp que será conectado (com histórico de uso real —
      número novo/reciclado toma restrição; NUNCA testar com o número
      principal do cliente)
- [ ] E-mail do admin do cliente (se ele for ter acesso)

## 1. Supabase (banco novo)

1. [supabase.com](https://supabase.com) → New project (org da Valione),
   região `sa-east-1`, senha forte do banco (guardar no cofre).
2. Aplicar TODAS as migrações de `supabase/migrations/` em ordem:
   - Via SQL Editor (colar cada arquivo), ou
   - Via Management API com token `sbp_` (pedir ao Claude — usar node
     fetch; Python é bloqueado pelo Cloudflare). Revogar o token depois.
3. Anotar: `Project URL`, `anon key`, `service_role key`
   (Settings → API).

## 2. Chaves novas (NUNCA reaproveitar de outro cliente)

```bash
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -hex 32   # UAZAPI_WEBHOOK_SECRET
openssl rand -hex 32   # AUTOMATION_CRON_SECRET
```

## 3. Uazapi

Opção A (mesmo servidor Uazapi da Valione): usar a mesma `UAZAPI_URL` +
`UAZAPI_ADMIN_TOKEN`; as instâncias não colidem (nome `wacrm_<account_id>`)
e cada instalação tem seu próprio `UAZAPI_WEBHOOK_SECRET`. Conferir se o
plano comporta mais uma instância.
Opção B: servidor Uazapi dedicado do cliente (URL + admintoken próprios).

## 4. Branch de marca

```bash
git checkout personalizacao-display4 && git pull
git checkout -b cliente-x
# substituir a marca (mesmos caminhos):
#   public/brand/display4-logo.svg  → logo do cliente (nome pode manter ou trocar; se trocar, atualizar os 2 usos: sidebar.tsx e login/page.tsx)
#   public/brand/display4-icon.svg  → ícone do cliente
#   src/app/icon.svg                → favicon (= ícone)
git add -A && git commit -m "brand: cliente X"
git push -u origin cliente-x
```

Notas de marca:
- Nome do app NÃO é código — vai na env `NEXT_PUBLIC_APP_NAME`.
- Rodapé "by *Valione Intelligence*." é fixo do produto (não mudar).
- SVGs de logo usam `unoptimized` no next/image (o otimizador bloqueia SVG).
- Atualizações do produto: `git checkout cliente-x && git merge personalizacao-display4 && git push`.

## 5. Hostinger (app Node)

1. hPanel → Websites → Adicionar site → **Aplicação Web Node.js** com o
   subdomínio do cliente (plano atual: até 5 apps).
2. Importar do GitHub `valione/wacrm` (app já autorizado) → **Branch:
   `cliente-x`** (conferir! o padrão do repo é a branch da Display4) →
   preset Next.js, Node 20.x, build padrão.
3. Variáveis de ambiente (Importar .env):

```
NEXT_PUBLIC_SUPABASE_URL=<do passo 1>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<do passo 1>
SUPABASE_SERVICE_ROLE_KEY=<do passo 1>
ENCRYPTION_KEY=<do passo 2>
UAZAPI_URL=<do passo 3>
UAZAPI_ADMIN_TOKEN=<do passo 3>
UAZAPI_WEBHOOK_SECRET=<do passo 2>
AUTOMATION_CRON_SECRET=<do passo 2>
NEXT_PUBLIC_APP_LOCALE=pt
NEXT_PUBLIC_APP_NAME=ClienteX | CRM
NEXT_PUBLIC_SITE_URL=https://crm.clientex.com.br
```

4. Implantar. SSL automático leva ~5 min após o DNS apontar.
5. Ativar a implantação automática (padrão) — push na branch = deploy.

## 6. Contas e WhatsApp

1. Abrir o domínio → **Criar conta** (e-mail da Valione = owner/admin).
2. Configurações → WhatsApp → Uazapi → conectar via QR com o número do
   cliente. A conexão registra o webhook com a URL de produção
   automaticamente. Escanear UMA vez; sem ciclos de conectar/desconectar.
3. Convidar o admin do cliente (Configurações → Membros), papel a critério.

## 7. Crons (cron-job.org, conta da Valione)

3 jobs, **a cada 1 minuto**, trocando `<dominio>` e `<AUTOMATION_CRON_SECRET>`:

```
https://<dominio>/api/broadcasts/cron?secret=<AUTOMATION_CRON_SECRET>
https://<dominio>/api/automations/cron?secret=<AUTOMATION_CRON_SECRET>
https://<dominio>/api/flows/cron?secret=<AUTOMATION_CRON_SECRET>
```

## 8. Fumaça (não pular)

- [ ] `/login` abre com logo/nome do cliente e rodapé com versão
- [ ] Mensagem de OUTRO celular → aparece no Inbox
- [ ] Resposta pelo Inbox → chega no celular (status entregue/lida)
- [ ] Foto recebida aparece com imagem
- [ ] Transmissão agendada p/ +5 min sai sozinha (prova do cron)
- [ ] Marcador: `wa.me/<numero>?text=...%5Bref%3Asite-home%5D` de um
      contato SEM conversa prévia → origem "Site", texto sem o código

## 9. Marketing (quando o cliente tiver os acessos)

Seguir `docs/marketing.md`: GA4 (service account NOVA ou a mesma da
Valione com Leitor na propriedade do cliente + property ID) e Meta Ads
(usuário de sistema no Business do cliente, token `ads_read` + ad account
ID). Conferir ANTES se o site do cliente realmente envia dados ao GA4
(olhar Tempo real; na Display4 o GTM não tinha tag GA4 nenhuma).

## Pós-instalação

- Registrar a instalação em `CHANGELOG.display4.md`? Não — criar
  `CHANGELOG.clientex.md` na branch do cliente apenas se houver
  divergências; o changelog do produto vale para todos.
- Guardar no cofre da Valione: senha do banco, chaves geradas, tokens.
- Apagar qualquer arquivo `.env` temporário usado na importação.
