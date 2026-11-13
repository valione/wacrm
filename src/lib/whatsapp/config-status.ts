/**
 * Se a conta tem um WhatsApp configurado, olhando a linha de whatsapp_config.
 * A API oficial da Meta grava phone_number_id; as conexões por QR Code
 * (Uazapi, WAHA) gravam provider_session e deixam phone_number_id nulo.
 */
export function isWhatsAppConfigured(
  row: { phone_number_id: string | null; provider_session: string | null } | null | undefined,
): boolean {
  return Boolean(row?.phone_number_id || row?.provider_session)
}
