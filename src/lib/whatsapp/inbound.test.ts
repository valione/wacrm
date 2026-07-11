import { describe, it, expect } from 'vitest'
import { isValidStatusTransition } from './inbound'

describe('isValidStatusTransition (movida do webhook)', () => {
  it('sobe a escada', () => {
    expect(isValidStatusTransition('pending', 'sent')).toBe(true)
    expect(isValidStatusTransition('sent', 'delivered')).toBe(true)
    expect(isValidStatusTransition('delivered', 'read')).toBe(true)
  })
  it('não desce nem falha tarde', () => {
    expect(isValidStatusTransition('read', 'delivered')).toBe(false)
    expect(isValidStatusTransition('delivered', 'failed')).toBe(false)
  })
})
