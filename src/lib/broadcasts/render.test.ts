import { describe, it, expect } from 'vitest'
import { renderBroadcastText } from './render'

describe('renderBroadcastText', () => {
  it('substitui {{nome}} pelo nome do contato', () => {
    expect(renderBroadcastText('Oi {{nome}}, tudo bem?', { name: 'Maria' }))
      .toBe('Oi Maria, tudo bem?')
  })
  it('substitui campos personalizados', () => {
    expect(renderBroadcastText('Sua empresa {{empresa}} foi aprovada', {
      name: 'Ana', customValues: { empresa: 'ACME' },
    })).toBe('Sua empresa ACME foi aprovada')
  })
  it('placeholder sem valor vira string vazia', () => {
    expect(renderBroadcastText('Oi {{nome}} da {{empresa}}', { name: null }))
      .toBe('Oi  da ')
  })
  it('é case-insensitive na chave e tolera espaços internos', () => {
    expect(renderBroadcastText('Oi {{ Nome }}', { name: 'Bia' })).toBe('Oi Bia')
  })
  it('texto sem placeholder passa intacto', () => {
    expect(renderBroadcastText('Promoção hoje!', {})).toBe('Promoção hoje!')
  })
  it('chaves não fechadas não explodem', () => {
    expect(renderBroadcastText('Oi {{nome', { name: 'X' })).toBe('Oi {{nome')
  })
  it('substitui chave de campo personalizado com espaço', () => {
    expect(renderBroadcastText('Nascido em {{data de nascimento}}', {
      name: 'Ana', customValues: { 'data de nascimento': '01/01/1990' },
    })).toBe('Nascido em 01/01/1990')
  })
  it('chave com espaço sem valor vira string vazia', () => {
    expect(renderBroadcastText('Nascido em {{data de nascimento}}', { name: 'Ana' }))
      .toBe('Nascido em ')
  })
  it('chave multi-palavra com espaços nas bordas resolve trimada', () => {
    expect(renderBroadcastText('Nascido em {{ Data de Nascimento }}', {
      name: 'Ana', customValues: { 'data de nascimento': '01/01/1990' },
    })).toBe('Nascido em 01/01/1990')
  })
  it("regressão ReDoS: '{{' não fechado + 500 espaços renderiza em <50ms", () => {
    const pathological = '{{' + ' '.repeat(500)
    const start = performance.now()
    const result = renderBroadcastText(pathological, { name: 'X' })
    const elapsed = performance.now() - start
    expect(result).toBe(pathological)
    expect(elapsed).toBeLessThan(50)
  })
})
