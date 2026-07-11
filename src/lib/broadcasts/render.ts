// Renderiza placeholders {{chave}} do texto livre de transmissões.
// 'nome' (e 'name') resolvem para contact.name; qualquer outra chave
// resolve para customValues[chave]. Sem valor → string vazia, para a
// mensagem nunca vazar um "{{empresa}}" cru para o cliente.

export function renderBroadcastText(
  template: string,
  contact: { name?: string | null; customValues?: Record<string, string | null> },
): string {
  return template.replace(/\{\{\s*([\wÀ-ſ]+)\s*\}\}/g, (_m, rawKey: string) => {
    const key = rawKey.toLowerCase()
    if (key === 'nome' || key === 'name') return contact.name ?? ''
    return contact.customValues?.[key] ?? contact.customValues?.[rawKey] ?? ''
  })
}
