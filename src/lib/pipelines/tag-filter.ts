/**
 * Filtro por tag do quadro de Pipeline. As tags são do contato do negócio
 * (contact_tags). Várias tags marcadas = OU, igual ao filtro da Caixa de
 * entrada. Negócio sem contato só aparece sem filtro.
 */

/** O select do quadro embute `contact:contacts(*, contact_tags(tag_id))`;
 *  o tipo Contact não declara esse campo, então lemos de forma solta. */
export function contactTagIds(deal: { contact?: unknown }): string[] {
  const c = deal.contact as { contact_tags?: { tag_id: string }[] | null } | null | undefined;
  return (c?.contact_tags ?? []).map((ct) => ct.tag_id);
}

export function filterDealsByTags<T extends { contact?: unknown }>(deals: T[], tagIds: string[]): T[] {
  if (tagIds.length === 0) return deals;
  return deals.filter((d) => contactTagIds(d).some((id) => tagIds.includes(id)));
}
