import { describe, it, expect } from 'vitest'
import { sliceBudget, jitterMs, isBroadcastComplete, finalStatus } from './processor'

describe('sliceBudget', () => {
  it('usa o rate default 10 quando o tempo não é o gargalo', () => {
    expect(sliceBudget()).toBe(10)
    expect(sliceBudget(10, 60000)).toBe(10)
  })

  it('nunca retorna menos que 1, mesmo com orçamento de tempo mínimo', () => {
    expect(sliceBudget(10, 0)).toBe(1)
    expect(sliceBudget(10, 500)).toBe(1)
  })

  it('respeita o rate informado quando menor que o teto de tempo', () => {
    expect(sliceBudget(5, 60000)).toBe(5)
    expect(sliceBudget(1, 60000)).toBe(1)
  })

  it('limita pelo orçamento de tempo quando o rate é alto', () => {
    // ~2s por envio → em 60s cabem ~30 envios, então rate 100 é cortado.
    expect(sliceBudget(100, 60000)).toBe(30)
  })
})

describe('jitterMs', () => {
  it('retorna sempre entre 1000 e 3000 ms', () => {
    for (let i = 0; i < 100; i++) {
      const v = jitterMs()
      expect(v).toBeGreaterThanOrEqual(1000)
      expect(v).toBeLessThanOrEqual(3000)
    }
  })
})

describe('isBroadcastComplete', () => {
  it('é completa quando não há pendentes', () => {
    expect(isBroadcastComplete({ pending: 0 })).toBe(true)
  })

  it('não é completa enquanto houver pendentes', () => {
    expect(isBroadcastComplete({ pending: 1 })).toBe(false)
    expect(isBroadcastComplete({ pending: 42 })).toBe(false)
  })
})

describe('finalStatus', () => {
  it("é 'sent' quando ao menos um envio teve sucesso", () => {
    expect(finalStatus({ sentCount: 1 })).toBe('sent')
    expect(finalStatus({ sentCount: 500 })).toBe('sent')
  })

  it("é 'failed' quando nada foi enviado", () => {
    expect(finalStatus({ sentCount: 0 })).toBe('failed')
  })
})
