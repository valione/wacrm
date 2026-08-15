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
