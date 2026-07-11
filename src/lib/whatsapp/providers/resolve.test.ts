import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('resolveProvider', () => {
  beforeEach(() => {
    vi.stubEnv('WAHA_URL', 'http://waha.local:3001')
    vi.stubEnv('WAHA_API_KEY', 'k')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('meta: exige accessToken e expõe capacidades da Meta', async () => {
    const { resolveProvider } = await import('./resolve')
    const p = resolveProvider({ provider: 'meta', phone_number_id: '123', provider_session: null }, 'tok')
    expect(p.name).toBe('meta')
    expect(p.capabilities).toMatchObject({ supportsTemplates: true, has24hWindow: true })
  })

  it('waha: sem janela de 24h nem templates', async () => {
    const { resolveProvider } = await import('./resolve')
    const p = resolveProvider({ provider: 'waha', phone_number_id: null, provider_session: 'wacrm_a1' }, null)
    expect(p.name).toBe('waha')
    expect(p.capabilities).toMatchObject({ supportsTemplates: false, has24hWindow: false, supportsInteractive: false })
  })

  it('waha sem provider_session lança erro claro', async () => {
    const { resolveProvider } = await import('./resolve')
    expect(() => resolveProvider({ provider: 'waha', phone_number_id: null, provider_session: null }, null))
      .toThrow(/sessão WAHA/)
  })
})
