import { describe, it, expect } from 'vitest'
import { resolveStatusPatch } from './status-sync'

describe('resolveStatusPatch', () => {
  it('heals a stuck "connecting" when the provider says connected', () => {
    expect(resolveStatusPatch('connecting', true)).toBe('connected')
  })

  it('marks a dead session down when the store still says connected', () => {
    expect(resolveStatusPatch('connected', false)).toBe('disconnected')
  })

  it('leaves an accurate store alone', () => {
    expect(resolveStatusPatch('connected', true)).toBeNull()
    expect(resolveStatusPatch('disconnected', false)).toBeNull()
  })

  it('never stomps a mid-flight QR connect with "disconnected"', () => {
    expect(resolveStatusPatch('connecting', false)).toBeNull()
    expect(resolveStatusPatch(null, false)).toBeNull()
  })

  it('fills in from null when live is connected', () => {
    expect(resolveStatusPatch(null, true)).toBe('connected')
  })
})
