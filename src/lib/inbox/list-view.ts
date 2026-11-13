/**
 * Regras de exibição da Caixa de entrada no jeito do WhatsApp: a conversa
 * com movimento mais recente fica no topo, e cada conversa mostra a fase
 * do negócio do contato.
 */

/** Mais recente primeiro. O tempo real atualiza a conversa no lugar; a
 *  lista reordena aqui para ela subir sem recarregar a página. */
export function sortByRecent<T extends { last_message_at?: string | null; created_at: string }>(
  conversations: T[],
): T[] {
  const at = (c: T) => new Date(c.last_message_at ?? c.created_at).getTime()
  return [...conversations].sort((a, b) => at(b) - at(a))
}

export interface DealStageRow {
  contact_id: string | null
  stage_id: string
  status?: string | null
  created_at: string
  updated_at?: string | null
}

/**
 * Fase de cada contato. Com vários negócios, vale o aberto mais recente;
 * sem aberto, o mais recente de qualquer status.
 */
export function stageByContact(deals: DealStageRow[]): Map<string, string> {
  const best = new Map<string, DealStageRow>()
  const recency = (d: DealStageRow) => new Date(d.updated_at ?? d.created_at).getTime()
  const isOpen = (d: DealStageRow) => (d.status ?? 'open') === 'open'

  for (const d of deals) {
    if (!d.contact_id) continue
    const cur = best.get(d.contact_id)
    if (
      !cur ||
      (isOpen(d) && !isOpen(cur)) ||
      (isOpen(d) === isOpen(cur) && recency(d) > recency(cur))
    ) {
      best.set(d.contact_id, d)
    }
  }

  const out = new Map<string, string>()
  for (const [contactId, d] of best) out.set(contactId, d.stage_id)
  return out
}
