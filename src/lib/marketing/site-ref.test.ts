import { describe, it, expect } from 'vitest'
import { extractSiteRef } from './site-ref'

describe('extractSiteRef', () => {
  it('extrai o ref e remove o marcador quando presente', () => {
    expect(extractSiteRef('Olá! Vim pelo site [ref:site-home]')).toEqual({
      ref: 'site-home',
      cleanText: 'Olá! Vim pelo site',
    })
  })

  it('retorna ref null e texto intacto quando não há marcador', () => {
    expect(extractSiteRef('Olá, tudo bem?')).toEqual({
      ref: null,
      cleanText: 'Olá, tudo bem?',
    })
  })

  it('remove marcador no meio do texto normalizando o espaço duplo', () => {
    expect(extractSiteRef('olá [ref:promo_2026] tudo bem')).toEqual({
      ref: 'promo_2026',
      cleanText: 'olá tudo bem',
    })
  })

  it('ignora slug inválido (com espaço) deixando o texto inalterado', () => {
    expect(extractSiteRef('quero saber [ref:tem espaco] sobre isso')).toEqual({
      ref: null,
      cleanText: 'quero saber [ref:tem espaco] sobre isso',
    })
  })

  it('com dois marcadores usa o primeiro e remove todos', () => {
    expect(extractSiteRef('[ref:landing-a] oi [ref:landing-b]')).toEqual({
      ref: 'landing-a',
      cleanText: 'oi',
    })
  })

  it('trata string vazia sem erro', () => {
    expect(extractSiteRef('')).toEqual({ ref: null, cleanText: '' })
  })
})
