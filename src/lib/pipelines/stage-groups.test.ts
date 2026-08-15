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
