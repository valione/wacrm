"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { stageByContact, type DealStageRow } from "@/lib/inbox/list-view";

export interface StageBadge {
  name: string;
  color: string;
}

/**
 * Fase do negócio de cada contato, para a pílula na lista de conversas.
 * Recarrega junto com a lista (resyncToken: reconexão do tempo real ou
 * volta à aba) — mudança de fase feita agora aparece no próximo resync.
 */
export function useContactStages(resyncToken: number): Map<string, StageBadge> {
  const [badges, setBadges] = useState<Map<string, StageBadge>>(new Map());

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const [deals, stages] = await Promise.all([
        supabase.from("deals").select("contact_id, stage_id, status, created_at, updated_at"),
        supabase.from("pipeline_stages").select("id, name, color"),
      ]);
      if (cancelled || !deals.data || !stages.data) return;

      const stageInfo = new Map(
        (stages.data as { id: string; name: string; color: string }[]).map((s) => [
          s.id,
          { name: s.name, color: s.color },
        ]),
      );
      const out = new Map<string, StageBadge>();
      for (const [contactId, stageId] of stageByContact(deals.data as DealStageRow[])) {
        const info = stageInfo.get(stageId);
        if (info) out.set(contactId, info);
      }
      setBadges(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [resyncToken]);

  return badges;
}
