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
})
