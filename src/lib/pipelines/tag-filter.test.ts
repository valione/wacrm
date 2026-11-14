import { describe, expect, it } from 'vitest'
import { filterDealsByTags } from './tag-filter'

const a = { id: 'a', contact: { contact_tags: [{ tag_id: 't1' }, { tag_id: 't2' }] } }
const b = { id: 'b', contact: { contact_tags: [{ tag_id: 't3' }] } }
const semTag = { id: 'c', contact: { contact_tags: [] } }
const semContato = { id: 'd', contact: null }
const all = [a, b, semTag, semContato]

describe('filterDealsByTags', () => {
  it('sem tag marcada devolve tudo', () => {
    expect(filterDealsByTags(all, [])).toBe(all)
  })
  it('uma tag', () => {
    expect(filterDealsByTags(all, ['t3']).map((d) => d.id)).toEqual(['b'])
  })
  it('várias tags = OU', () => {
    expect(filterDealsByTags(all, ['t1', 't3']).map((d) => d.id)).toEqual(['a', 'b'])
  })
  it('sem contato ou sem tag some quando há filtro', () => {
    expect(filterDealsByTags(all, ['t2']).map((d) => d.id)).toEqual(['a'])
  })
})
