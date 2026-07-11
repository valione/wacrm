// Renderiza placeholders {{chave}} do texto livre de transmissões.
// 'nome' (e 'name') resolvem para contact.name; qualquer outra chave
// resolve para customValues[chave]. Sem valor → string vazia, para a
// mensagem nunca vazar um "{{empresa}}" cru para o cliente.

export function renderBroadcastText(
  template: string,
  contact: { name?: string | null; customValues?: Record<string, string | null> },
): string {
  // Field names are free text (see custom-fields-manager.tsx), so
  // multi-word keys like "data de nascimento" must match too — only
  // exclude the brace characters themselves, not \w.
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, rawKey: string) => {
    const trimmed = rawKey.trim()
    const key = trimmed.toLowerCase()
    if (key === 'nome' || key === 'name') return contact.name ?? ''
    return contact.customValues?.[key] ?? contact.customValues?.[trimmed] ?? ''
  })
}
