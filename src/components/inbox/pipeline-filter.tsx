"use client";

/**
 * Filtro da Caixa de entrada por pipeline → fase. Dois menus em
 * sequência: escolhido o pipeline, aparece o de fase. Devolve ao pai o
 * conjunto de contatos que casam (ou null quando não há filtro).
 *
 * Componente próprio (e não dentro de conversation-list.tsx) para o
 * merge do upstream mexer o mínimo na lista.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  contactIdsInPipeline,
  type DealPlacement,
  type PipelineSelection,
} from "@/lib/inbox/pipeline-filter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Pipeline, PipelineStage } from "@/types";

export interface PipelineFilterValue {
  selection: PipelineSelection;
  label: string;
  contactIds: Set<string>;
}

const TRIGGER =
  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted";

export function PipelineFilter({
  value,
  onChange,
}: {
  value: PipelineFilterValue | null;
  onChange: (v: PipelineFilterValue | null) => void;
}) {
  const t = useTranslations("PipelineFilter");
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const [p, s] = await Promise.all([
        supabase.from("pipelines").select("*").order("created_at"),
        supabase.from("pipeline_stages").select("*").order("position"),
      ]);
      if (cancelled) return;
      if (p.data) setPipelines(p.data as Pipeline[]);
      if (s.data) setStages(s.data as PipelineStage[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selPipeline = value?.selection.pipelineId ?? null;
  const selStage = value?.selection.stageId ?? null;
  const pipelineStages = useMemo(
    () => stages.filter((s) => s.pipeline_id === selPipeline),
    [stages, selPipeline],
  );

  // Negócios lidos na hora da escolha: o quadro muda o tempo todo e
  // não vale manter uma assinatura em tempo real só para o filtro.
  async function select(selection: PipelineSelection | null) {
    if (!selection) {
      onChange(null);
      return;
    }
    const supabase = createClient();
    const { data } = await supabase
      .from("deals")
      .select("contact_id, pipeline_id, stage_id")
      .eq("pipeline_id", selection.pipelineId);
    const pipeline = pipelines.find((p) => p.id === selection.pipelineId);
    const stage = stages.find((s) => s.id === selection.stageId);
    onChange({
      selection,
      label: stage ? `${pipeline?.name} · ${stage.name}` : pipeline?.name ?? "",
      contactIds: contactIdsInPipeline((data ?? []) as DealPlacement[], selection),
    });
  }

  if (pipelines.length === 0) return null;

  const pipelineName = pipelines.find((p) => p.id === selPipeline)?.name;
  const stageName = stages.find((s) => s.id === selStage)?.name;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            TRIGGER,
            selPipeline ? "text-primary" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="truncate">{pipelineName ?? t("pipeline")}</span>
          <ChevronDown className="h-3 w-3 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-64 w-56 border-border bg-popover">
          <DropdownMenuItem
            onClick={() => select(null)}
            className={cn("text-sm", !selPipeline ? "text-primary" : "text-popover-foreground")}
          >
            {t("allPipelines")}
          </DropdownMenuItem>
          {pipelines.map((p) => (
            <DropdownMenuItem
              key={p.id}
              onClick={() => select({ pipelineId: p.id, stageId: null })}
              className={cn("text-sm", selPipeline === p.id ? "text-primary" : "text-popover-foreground")}
            >
              <span className="truncate">{p.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {selPipeline && pipelineStages.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            className={cn(
              TRIGGER,
              selStage ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="truncate">{stageName ?? t("stage")}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-64 w-56 border-border bg-popover">
            <DropdownMenuItem
              onClick={() => select({ pipelineId: selPipeline, stageId: null })}
              className={cn("text-sm", !selStage ? "text-primary" : "text-popover-foreground")}
            >
              {t("allStages")}
            </DropdownMenuItem>
            {pipelineStages.map((s) => (
              <DropdownMenuItem
                key={s.id}
                onClick={() => select({ pipelineId: selPipeline, stageId: s.id })}
                className={cn("text-sm", selStage === s.id ? "text-primary" : "text-popover-foreground")}
              >
                <span className="flex items-center gap-2">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                  <span className="truncate">{s.name}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
