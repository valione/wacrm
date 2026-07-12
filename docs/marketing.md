# Dashboard de Marketing — guia de configuração

A página **Marketing** mostra métricas do Google Analytics 4, do Meta Ads e a
origem das conversas do WhatsApp (anúncio / site / direto). Este guia cobre
como obter cada credencial, como marcar o botão de WhatsApp do site para a
atribuição funcionar e as limitações conhecidas.

As credenciais são coladas uma única vez por um **administrador** em
**Configurações → Integrações de marketing**. Elas são validadas contra a
plataforma real antes de salvar, armazenadas criptografadas (AES-256-GCM) e
nunca são exibidas de volta.

## 1. Google Analytics 4 (service account + property ID)

1. Acesse [Google Cloud Console](https://console.cloud.google.com/) e crie um
   projeto (ou use um existente).
2. Em **APIs e serviços → Biblioteca**, ative a
   **Google Analytics Data API**.
3. Em **IAM e administrador → Contas de serviço**, crie uma conta de serviço
   (qualquer nome, sem papéis de projeto).
4. Na conta de serviço criada, aba **Chaves → Adicionar chave → JSON**. O
   navegador baixa um arquivo `.json` — é esse conteúdo inteiro que será
   colado no CRM.
5. No [Google Analytics](https://analytics.google.com/):
   **Administrador → Gerenciamento de acesso à propriedade → +** e adicione o
   e-mail da conta de serviço (`...@...iam.gserviceaccount.com`) com papel
   **Leitor**.
6. Ainda no Admin do GA4, em **Configurações da propriedade**, copie o
   **ID da propriedade** (só números, ex.: `123456789`).
7. No CRM: **Configurações → Integrações de marketing → Google Analytics 4**,
   cole o JSON completo + o ID da propriedade e clique em
   **Validar e salvar**.

## 2. Meta Ads (token de usuário de sistema + ID da conta de anúncios)

1. No [Business Manager](https://business.facebook.com/settings), abra
   **Usuários → Usuários do sistema** e crie um usuário de sistema (papel
   Funcionário basta).
2. Em **Adicionar ativos**, dê ao usuário de sistema acesso à **conta de
   anúncios** do cliente (permissão de visualizar desempenho é suficiente).
3. Clique em **Gerar token**: selecione um app do Business, marque o escopo
   **`ads_read`** e escolha validade **nunca expira** (ou 60 dias, se a
   política da empresa exigir — anote a data para renovar).
4. Copie o token (só aparece uma vez).
5. O **ID da conta de anúncios** está em **Contas de anúncios** no Business
   Manager (só os números, sem o prefixo `act_`).
6. No CRM: **Configurações → Integrações de marketing → Meta Ads**, cole o
   token + o ID e clique em **Validar e salvar**.

> Google Ads chega na **leva 2** (aguardando aprovação do developer token).
> O card já aparece na tela como "Em breve".

## 3. Botão de WhatsApp do site — marcador `[ref:]`

Para o dashboard saber que uma conversa veio **do site** (e de qual página),
o link do botão de WhatsApp deve pré-preencher a mensagem com um marcador
`[ref:<pagina>]`. O CRM detecta o marcador na primeira mensagem da conversa,
grava a origem e **remove o código do texto** antes de exibir/persistir —
nem o atendente nem o painel veem o `[ref:...]`.

Formato do link (o marcador vai URL-encodado: `%5Bref%3A...%5D`):

```html
<!-- Página inicial -->
<a href="https://wa.me/5511999999999?text=Ol%C3%A1!%20Vim%20pelo%20site%20%5Bref%3Asite-home%5D">
  Fale conosco no WhatsApp
</a>

<!-- Variação por página: troque só o valor do ref -->
<!-- página de produto:  ...%5Bref%3Aproduto-x%5D -->
<!-- página de contato:  ...%5Bref%3Acontato%5D -->
<!-- landing de campanha: ...%5Bref%3Alp-promo-julho%5D -->
```

Regras do marcador: letras, números, hífen e underscore, até 64 caracteres
(`[ref:site-home]`, `[ref:lp-promo-julho]`). Use um valor por página/CTA —
é ele que aparece na tabela "Conversas do site por página".

## 4. Evento GA4 `click_whatsapp` (cliques no botão por origem)

A tabela "Cliques no botão de WhatsApp" do dashboard lê um evento
personalizado `click_whatsapp` do GA4. Configure de uma das duas formas:

**Com gtag direto no site:**

```html
<a href="https://wa.me/5511999999999?text=..."
   onclick="gtag('event', 'click_whatsapp', { page: location.pathname });">
  Fale conosco no WhatsApp
</a>
```

**Com Google Tag Manager:**

1. **Acionador**: tipo "Clique — apenas links", condição
   `Click URL contém wa.me`.
2. **Tag**: tipo "Evento do GA4", nome do evento `click_whatsapp`,
   disparando no acionador acima.
3. Publique o contêiner e teste no modo Preview (o evento aparece no
   relatório em tempo real do GA4).

O dashboard mostra os cliques quebrados por origem/mídia da sessão
(ex.: `google / organic`, `direct / none`). Sem o evento configurado, a
tabela mostra um aviso explicando este passo.

## 5. Como a origem das conversas é atribuída

- **Anúncio** — anúncios "Clique para WhatsApp" (CTWA) entregam metadados de
  origem na primeira mensagem (ad_id, headline). Funciona no provedor Meta
  oficial; no Uazapi depende do payload do servidor (confirmar no E2E).
  **No provedor WAHA a atribuição de anúncio não funciona** — o webhook da
  WAHA não entrega o referral do CTWA (fora do escopo atual), então essas
  conversas caem em "Diretas / outras" mesmo com GA4/Meta configurados.
- **Site** — marcador `[ref:]` da seção 3.
- **Direto / outras** — sem referral e sem marcador.

## 6. Limitações conhecidas (aceitas no design)

- A atribuição de anúncio cobre **somente campanhas CTWA** (que abrem o
  WhatsApp). Campanhas de tráfego para o site aparecem com investimento mas
  sem conversas atribuídas — o dashboard sinaliza isso na seção de
  atribuição para a campanha não parecer "ruim".
- Se o lead **apagar o texto pré-preenchido** antes de enviar, o marcador
  `[ref:]` se perde e a conversa cai em "Direto / outras".
- Sem UTM/pixel nesta fase; sem receita/ROAS.
- No gráfico diário, os dias do Meta Ads seguem o fuso da conta de anúncios
  e as conversas seguem UTC — gasto feito no fim do dia pode aparecer um
  dia deslocado em relação à linha de conversas. Os totais do período não
  são afetados.
- Dados das plataformas ficam em cache por **1 hora**. Se uma atualização
  falhar, o painel serve os últimos dados obtidos com um aviso.
- O investimento é exibido na moeda padrão do CRM — mantenha a conta de
  anúncios na mesma moeda.

## 7. Roteiro de E2E manual (com credenciais reais)

1. **Credenciais**: colar GA4 e Meta em Configurações → validar que um token
   errado dá erro claro (422 com a mensagem da plataforma) e que o certo
   salva. Recarregar a tela: estado "Conectado", sem credencial exposta.
2. **Números**: abrir /marketing (7/30/90 dias) e comparar investimento,
   leads, sessões e conversões com os painéis nativos (Gerenciador de
   Anúncios e GA4). Tolerância: pequenas diferenças de fuso/atribuição.
3. **Cache**: recarregar a página em menos de 1h → resposta instantânea
   (cache). Conferir depois de 1h que os dados atualizam.
4. **Atribuição site**: enviar mensagem de teste por um link `wa.me` com
   `[ref:site-home]` → conversa aparece no inbox SEM o marcador no texto e
   conta em "Vindas do site" / "por página".
5. **Atribuição anúncio (CTWA)**: clicar num anúncio real de WhatsApp e
   mandar mensagem → conversa conta em "Vindas de anúncio" e aparece na
   tabela por anúncio. No Uazapi, confirmar o nome do campo de referral no
   payload do webhook.
6. **Erro isolado**: remover a integração GA4 → a seção GA4 some e o resto
   do painel continua; reconfigurar e conferir a volta.
7. **Gate do sidebar**: com usuário não-admin e nenhuma integração, o item
   Marketing não aparece; após configurar uma, aparece.
