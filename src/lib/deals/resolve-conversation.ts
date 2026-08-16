//
// Qual conversa um negócio aponta.
//
// A ordem importa: o vínculo JÁ GRAVADO vence a conversa detectada pelo
// contato. Sem isso, editar o valor de um negócio ligado à conversa A
// regravaria o vínculo para a B (a mais recente do contato), e a origem
// da oportunidade se perderia em silêncio.

export function resolveDealConversationId(
  existing: string | null | undefined,
  detected: string | null | undefined,
): string | null {
  return existing || detected || null;
}
