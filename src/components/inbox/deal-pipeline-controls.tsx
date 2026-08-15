//
// Controles de funil da barra lateral do Inbox. Componentes "burros":
// nenhum acesso a dados — quem grava é o contact-sidebar.
"use client";

import { ChevronDown, Check, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import type { Deal, PipelineStage } from "@/types";
import type { PipelineStageGroup } from "@/lib/pipelines/stage-groups";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

/**
 * O badge de fase do deal, agora clicável: abre as fases do funil DESTE
 * deal. Escolher a fase atual não chama `onSelect` (spec: sem escrita).
 */
export function DealStageSelect({
  deal,
  stages,
  onSelect,
}: {
  deal: Deal;
  stages: PipelineStage[];
  onSelect: (stage: PipelineStage) => void;
}) {
  if (!deal.stage) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px]"
        style={{
          backgroundColor: `${deal.stage.color}20`,
          color: deal.stage.color,
        }}
      >
        {deal.stage.name}
        <ChevronDown className="h-2.5 w-2.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {stages.map((stage) => (
          <DropdownMenuItem
            key={stage.id}
            className="text-xs"
            onClick={() => {
              if (stage.id !== deal.stage_id) onSelect(stage);
            }}
          >
            <span
              className="mr-2 h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: stage.color }}
            />
            {stage.name}
            {stage.id === deal.stage_id && <Check className="ml-auto h-3 w-3" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Ação de criar um negócio: fases agrupadas por funil — escolher a fase
 * determina o funil, sem conceito de "funil padrão". Não renderiza nada
 * quando não há fase alguma para escolher (conta sem funis).
 */
export function AddToPipelineMenu({
  groups,
  disabled,
  onSelect,
}: {
  groups: PipelineStageGroup[];
  disabled?: boolean;
  onSelect: (pipelineId: string, stage: PipelineStage) => void;
}) {
  const t = useTranslations("Inbox.sidebar");
  if (groups.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        className="mt-2 inline-flex w-full items-center rounded-md px-1 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
      >
        <Plus className="mr-1 h-3 w-3" />
        {t("addToPipeline")}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto">
        {groups.map((group, index) => (
          <DropdownMenuGroup key={group.pipeline.id}>
            {index > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {group.pipeline.name}
            </DropdownMenuLabel>
            {group.stages.map((stage) => (
              <DropdownMenuItem
                key={stage.id}
                className="text-xs"
                onClick={() => onSelect(group.pipeline.id, stage)}
              >
                <span
                  className="mr-2 h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: stage.color }}
                />
                {stage.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
