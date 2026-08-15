//
// Controles de funil da barra lateral do Inbox. Componentes "burros":
// nenhum acesso a dados — quem grava é o contact-sidebar.
"use client";

import { ChevronDown, Check } from "lucide-react";
import type { Deal, PipelineStage } from "@/types";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
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
            onSelect={() => {
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
