import { describe, expect, it } from 'vitest'
import { sortByRecent, stageByContact } from './list-view'

describe('sortByRecent', () => {
  it('conversa com mensagem mais nova vai para o topo', () => {
    const r = sortByRecent([
      { id: 'a', last_message_at: '2026-11-13T10:00:00Z', created_at: '2026-11-01T00:00:00Z' },
      { id: 'b', last_message_at: '2026-11-13T12:00:00Z', created_at: '2026-11-01T00:00:00Z' },
      { id: 'c', last_message_at: null, created_at: '2026-11-13T11:00:00Z' },
    ])
    expect(r.map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('não altera o array original', () => {
    const orig = [
      { id: 'a', last_message_at: '2026-11-13T10:00:00Z', created_at: '' },
      { id: 'b', last_message_at: '2026-11-13T12:00:00Z', created_at: '' },
    ]
    sortByRecent(orig)
    expect(orig[0].id).toBe('a')
  })
})

describe('stageByContact', () => {
  it('um negócio: a fase dele', () => {
    const m = stageByContact([{ contact_id: 'ana', stage_id: 's1', status: 'open', created_at: '2026-11-01' }])
    expect(m.get('ana')).toBe('s1')
  })

  it('negócio aberto vence um ganho/perdido mais recente', () => {
    const m = stageByContact([
      { contact_id: 'ana', stage_id: 'aberto', status: 'open', created_at: '2026-10-01' },
      { contact_id: 'ana', stage_id: 'perdido', status: 'lost', created_at: '2026-11-01' },
    ])
    expect(m.get('ana')).toBe('aberto')
  })

  it('entre abertos, vale o atualizado mais recentemente', () => {
    const m = stageByContact([
      { contact_id: 'ana', stage_id: 'velho', status: 'open', created_at: '2026-10-01', updated_at: '2026-10-02' },
      { contact_id: 'ana', stage_id: 'novo', status: 'open', created_at: '2026-09-01', updated_at: '2026-11-10' },
    ])
    expect(m.get('ana')).toBe('novo')
  })

  it('sem negócio aberto, vale o mais recente; negócio sem contato é ignorado', () => {
    const m = stageByContact([
      { contact_id: 'bia', stage_id: 'ganho', status: 'won', created_at: '2026-11-01' },
      { contact_id: 'bia', stage_id: 'perdido', status: 'lost', created_at: '2026-10-01' },
      { contact_id: null, stage_id: 'x', status: 'open', created_at: '2026-11-01' },
    ])
    expect(m.get('bia')).toBe('ganho')
    expect(m.size).toBe(1)
  })
})
