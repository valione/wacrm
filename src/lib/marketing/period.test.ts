import { describe, it, expect } from 'vitest'
import { periodWindow, isCacheFresh } from './period'

describe('periodWindow', () => {
  it('7d: janela de 7 dias terminando hoje (UTC), anterior de mesmo tamanho', () => {
    const now = new Date('2026-07-11T15:30:00.000Z')
    expect(periodWindow('7d', now)).toEqual({
      start: '2026-07-05',
      end: '2026-07-11',
      prevStart: '2026-06-28',
      prevEnd: '2026-07-04',
    })
  })

  it('30d: janela de 30 dias terminando hoje, anterior de 30 dias', () => {
    const now = new Date('2026-07-11T00:00:00.000Z')
    expect(periodWindow('30d', now)).toEqual({
      start: '2026-06-12',
      end: '2026-07-11',
      prevStart: '2026-05-13',
      prevEnd: '2026-06-11',
    })
  })

  it('90d: janela de 90 dias terminando hoje, anterior de 90 dias', () => {
    const now = new Date('2026-07-11T00:00:00.000Z')
    expect(periodWindow('90d', now)).toEqual({
      start: '2026-04-13',
      end: '2026-07-11',
      prevStart: '2026-01-13',
      prevEnd: '2026-04-12',
    })
  })

  it('respeita a data em UTC independente da hora do dia', () => {
    // 23:59 UTC ainda é o mesmo dia UTC — não deve "vazar" para o dia
    // seguinte por causa do fuso local do runner.
    const now = new Date('2026-01-01T23:59:59.000Z')
    expect(periodWindow('7d', now).end).toBe('2026-01-01')
  })

  it('atravessa virada de ano corretamente', () => {
    const now = new Date('2026-01-03T00:00:00.000Z')
    expect(periodWindow('7d', now)).toEqual({
      start: '2025-12-28',
      end: '2026-01-03',
      prevStart: '2025-12-21',
      prevEnd: '2025-12-27',
    })
  })
})

describe('isCacheFresh', () => {
  it('true quando buscado há menos de 1h', () => {
    const now = new Date('2026-07-11T12:00:00.000Z')
    const fetchedAt = '2026-07-11T11:30:00.000Z'
    expect(isCacheFresh(fetchedAt, now)).toBe(true)
  })

  it('false quando buscado há exatamente 1h (limite exclusivo)', () => {
    const now = new Date('2026-07-11T12:00:00.000Z')
    const fetchedAt = '2026-07-11T11:00:00.000Z'
    expect(isCacheFresh(fetchedAt, now)).toBe(false)
  })

  it('false quando buscado há mais de 1h', () => {
    const now = new Date('2026-07-11T12:00:00.000Z')
    const fetchedAt = '2026-07-11T10:00:00.000Z'
    expect(isCacheFresh(fetchedAt, now)).toBe(false)
  })

  it('true logo após o fetch (poucos ms de diferença)', () => {
    const now = new Date('2026-07-11T12:00:00.001Z')
    const fetchedAt = '2026-07-11T12:00:00.000Z'
    expect(isCacheFresh(fetchedAt, now)).toBe(true)
  })

  it('false para timestamp inválido (nunca lança)', () => {
    const now = new Date('2026-07-11T12:00:00.000Z')
    expect(isCacheFresh('not-a-date', now)).toBe(false)
  })
})
