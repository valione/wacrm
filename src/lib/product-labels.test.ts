import { describe, expect, it } from 'vitest'
import ptMessages from '../../messages/pt.json'
import enMessages from '../../messages/en.json'
import { applyProductLabels, CAMINHOS_DO_PRODUTO } from './product-labels'

function ler(obj: unknown, caminho: string): unknown {
  return caminho
    .split('.')
    .reduce<unknown>((no, parte) => (no as Record<string, unknown> | undefined)?.[parte], obj)
}

describe('applyProductLabels', () => {
  it('todo caminho trocado existe hoje no pt.json (avisa quando o upstream renomear)', () => {
    for (const caminho of CAMINHOS_DO_PRODUTO.pt) {
      expect(typeof ler(ptMessages, caminho), caminho).toBe('string')
    }
  })

  it('troca Agente por Atendente e usa exemplos brasileiros em pt', () => {
    const r = applyProductLabels(ptMessages, 'pt')
    expect(ler(r, 'Sidebar.roleAgent')).toBe('Atendente')
    expect(ler(r, 'Settings.roles.agent')).toBe('Atendente')
    expect(ler(r, 'Contacts.form.phonePlaceholder')).toBe('+5511999999999')
    expect(ler(r, 'LoginPage.emailPlaceholder')).toBe('voce@exemplo.com')
  })

  it('não mexe nos Agentes de IA', () => {
    const r = applyProductLabels(ptMessages, 'pt')
    expect(ler(r, 'Sidebar.aiAgents')).toBe(ler(ptMessages, 'Sidebar.aiAgents'))
  })

  it('não altera o dicionário original nem outros idiomas', () => {
    const antes = ler(ptMessages, 'Sidebar.roleAgent')
    applyProductLabels(ptMessages, 'pt')
    expect(ler(ptMessages, 'Sidebar.roleAgent')).toBe(antes)
    expect(applyProductLabels(enMessages, 'en')).toBe(enMessages)
  })
})
