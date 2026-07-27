# Changelog — Display4 | CRM

Histórico de versões DESTA instalação (as versões do projeto-base wacrm
ficam no `CHANGELOG.md` original, mantido em arquivo separado para não
conflitar ao puxar atualizações do upstream).

Convenção: **minor** (1.1 → 1.2) a cada deploy com ajustes e novidades;
**major** (2.0) em mudanças grandes. A versão vem do `package.json` e
aparece no rodapé do app; cada versão publicada ganha uma tag git
(`v1.0.0`, `v1.1.0`, ...).

## v1.3 — 2026-07-27

- Iniciar conversa com **mensagem livre** nos provedores por QR Code
  (Uazapi/WAHA), que não têm a janela de 24h da Meta: botão "+" no topo
  da lista do Inbox (escolhe um contato ou digita um número novo, que
  vira contato automaticamente) e "Enviar mensagem" na ficha do contato.
  Em contas Meta os botões não aparecem — lá a primeira mensagem
  continua tendo de ser um modelo aprovado.

## v1.2 — 2026-07-12

- Rotas de cron (transmissões, automações, fluxos) aceitam o segredo
  também pela URL (`?secret=`), viabilizando pingers gratuitos que não
  enviam headers (cron-job.org, UptimeRobot).

## v1.1 — 2026-07-12

- Azul (Cobalt, cor da marca) como tema padrão para todos os usuários.
- Logo centralizado na tela de login.
- Versão do app exibida no rodapé (sidebar e login).

## v1.0 — 2026-07-12

Primeira versão em produção: https://crm.display4.com.br (Hostinger).

- CRM completo em português (base wacrm + Supabase).
- WhatsApp por três provedores: Meta oficial, WAHA e **Uazapi** (QR Code) —
  conversas, mídia nos dois sentidos, reações, recibos de status. E2E
  validado ao vivo no Uazapi.
- Transmissões (fase 2): texto livre com placeholders (`{{nome}}` e campos
  personalizados), mídia, agendamento e processador em segundo plano com
  ritmo anti-banimento.
- Dashboard de marketing: GA4 + Meta Ads (investimento, leads, CPL,
  campanhas), atribuição de origem das conversas (Anúncio CTWA / Site via
  marcador `[ref:]` / Direto) e custo por conversa. Guia em
  `docs/marketing.md`.
- Rebrand Display4: nome, logo, favicon e assinatura
  "Display4 | CRM by *Valione Intelligence*." — marca parametrizada por
  env (`NEXT_PUBLIC_APP_NAME`) para futuras instalações por cliente.
