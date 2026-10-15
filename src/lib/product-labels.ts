/**
 * Textos em que o produto da Valione diverge da tradução oficial do
 * upstream, valendo para todas as instalações. Ficam aqui, e não editados
 * em messages/pt.json, porque cada atualização do upstream regrava o
 * pt.json com a tradução deles — esta camada sobrevive ao merge.
 *
 * - "Atendente" para o humano: o upstream usa "Agente", que colide com os
 *   "Agentes de IA" do menu.
 * - Exemplos brasileiros nos campos (+55, exemplo.com) no lugar dos
 *   genéricos (+1, example.com).
 *
 * Aplicado antes da vertical, que pode sobrepor o que estiver aqui.
 */

import { gravarCaminho } from './vertical'

const PRODUTO_PT: Record<string, string> = {
  'Sidebar.roleAgent': 'Atendente',
  'Settings.roles.agent': 'Atendente',
  'Flows.logs.statusPaused': 'Pausada pelo atendente',
  'Flows.builder.form.internalNote': 'Nota interna (para o atendente que assumir)',
  'Flows.builder.nodes.handoff.label': 'Transferir para atendente',
  'Flows.list.emptyDesc':
    'Crie sua primeira conversa — um menu de boas-vindas, uma consulta de pedido, um bot de FAQ. Os clientes tocam em botões; o bot os leva à resposta certa (ou ao atendente certo).',
  'Settings.aiConfig.autoReplyDesc':
    'O bot responde automaticamente a novas mensagens recebidas (apenas quando nenhum fluxo as trata e nenhum atendente está atribuído). Transfere para um humano quando não consegue ajudar.',
  'Settings.aiConfig.handoffQueue': 'Fila sem atribuição (qualquer atendente pode assumir)',

  'LoginPage.emailPlaceholder': 'voce@exemplo.com',
  'SignupPage.emailPlaceholder': 'voce@exemplo.com',
  'ForgotPasswordPage.emailPlaceholder': 'voce@exemplo.com',
  'Contacts.form.phonePlaceholder': '+5511999999999',
  'Contacts.form.emailPlaceholder': 'maria@exemplo.com',
  'Broadcasts.wizard.personalize.imageUrlPlaceholder': 'https://exemplo.com/imagem.jpg',
  'Settings.templates.urlPlaceholder': 'https://exemplo.com/caminho ou com sufixo {{1}}',
  'Settings.templates.phonePlaceholder': '+5511912345678',
}

const TABELAS: Record<string, Record<string, string>> = { pt: PRODUTO_PT }

/** Caminhos que esta camada troca, por idioma (usado nos testes). */
export const CAMINHOS_DO_PRODUTO: Record<string, string[]> = {
  pt: Object.keys(PRODUTO_PT),
}

export function applyProductLabels<T extends object>(messages: T, locale: string): T {
  const tabela = TABELAS[locale]
  if (!tabela) return messages

  let resultado = messages
  for (const [caminho, valor] of Object.entries(tabela)) {
    resultado = gravarCaminho(resultado, caminho, valor)
  }
  return resultado
}
