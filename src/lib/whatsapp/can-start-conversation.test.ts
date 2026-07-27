import { describe, it, expect } from 'vitest'
import { canStartConversation } from './can-start-conversation'
import { CAPABILITIES } from './providers/types'

describe('canStartConversation', () => {
  it('allows QR providers (no 24h window)', () => {
    expect(canStartConversation(CAPABILITIES.uazapi)).toBe(true)
    expect(canStartConversation(CAPABILITIES.waha)).toBe(true)
  })

  it('blocks Meta — business-initiated sends must be templates', () => {
    expect(canStartConversation(CAPABILITIES.meta)).toBe(false)
  })

  it('blocks while capabilities are unresolved', () => {
    expect(canStartConversation(null)).toBe(false)
  })
})
