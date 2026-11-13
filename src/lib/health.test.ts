import { describe, expect, it } from 'vitest'
import { evaluateHealth, rulesFromEnv } from './health'

// 2026-11-13 é sexta. 15h de Brasília = 18h UTC.
const FRI_15H = new Date('2026-11-13T18:00:00Z')
const FRI_09H = new Date('2026-11-13T12:00:00Z')
const SAT_15H = new Date('2026-11-14T18:00:00Z')

const ALL = rulesFromEnv({ HEALTH_REQUIRE_WHATSAPP: '1', HEALTH_MAX_SILENCE_HOURS: '4' })
const NONE = rulesFromEnv({})

const base = { dbOk: true, whatsappStatuses: ['connected'], lastCustomerMessageAt: '2026-11-13T17:30:00Z', now: FRI_15H }

describe('rulesFromEnv', () => {
  it('sem variáveis: só o banco é cobrado', () => {
    expect(NONE).toEqual({ requireWhatsapp: false, maxSilenceHours: null, businessStart: 8, businessEnd: 20 })
  })
  it('lê janela customizada', () => {
    expect(rulesFromEnv({ HEALTH_BUSINESS_HOURS: '9-18' })).toMatchObject({ businessStart: 9, businessEnd: 18 })
  })
})

describe('evaluateHealth', () => {
  it('tudo certo → ok', () => {
    expect(evaluateHealth(base, ALL)).toEqual({ ok: true, problems: [] })
  })

  it('banco fora → falha', () => {
    expect(evaluateHealth({ ...base, dbOk: false }, NONE).ok).toBe(false)
  })

  it('WhatsApp desconectado só falha quando a instalação exige', () => {
    const input = { ...base, whatsappStatuses: ['disconnected'] }
    expect(evaluateHealth(input, ALL).problems).toEqual(['WhatsApp desconectado'])
    expect(evaluateHealth(input, NONE).ok).toBe(true)
  })

  it('silêncio além do limite no expediente → falha', () => {
    const r = evaluateHealth({ ...base, lastCustomerMessageAt: '2026-11-13T12:00:00Z' }, ALL)
    expect(r.problems).toEqual(['nenhuma mensagem de cliente há mais de 4 h'])
  })

  it('silêncio não é cobrado no começo do dia nem no fim de semana', () => {
    const old = '2026-11-12T12:00:00Z'
    expect(evaluateHealth({ ...base, now: FRI_09H, lastCustomerMessageAt: old }, ALL).ok).toBe(true)
    expect(evaluateHealth({ ...base, now: SAT_15H, lastCustomerMessageAt: old }, ALL).ok).toBe(true)
  })
})
