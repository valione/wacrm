/**
 * Filtro da Caixa de entrada por pipeline e fase: a conversa entra se o
 * contato tem algum negócio no pipeline escolhido (e na fase, quando
 * escolhida). Negócios de qualquer status contam — é a fase em que o
 * card está no quadro.
 */

export interface PipelineSelection {
  pipelineId: string
  /** null = todas as fases do pipeline */
  stageId: string | null
}

export interface DealPlacement {
  contact_id: string | null
  pipeline_id: string
  stage_id: string
}

export function contactIdsInPipeline(
  deals: DealPlacement[],
  sel: PipelineSelection,
): Set<string> {
  const ids = new Set<string>()
  for (const d of deals) {
    if (!d.contact_id || d.pipeline_id !== sel.pipelineId) continue
    if (sel.stageId !== null && d.stage_id !== sel.stageId) continue
    ids.add(d.contact_id)
  }
  return ids
}
