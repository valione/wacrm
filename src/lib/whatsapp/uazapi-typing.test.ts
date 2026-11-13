import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ sendPresence: vi.fn() }))
vi.mock('./uazapi-api', () => ({ uazapiSendPresence: h.sendPresence }))
vi.mock('./encryption', () => ({ decrypt: (v: string) => `dec:${v}` }))

import { showUazapiTyping } from './uazapi-typing'

function fakeDb(rows: { config: unknown; contact: unknown }) {
  return {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve({ data: table === 'whatsapp_config' ? rows.config : rows.contact, error: null }),
      }
      return chain
    },
  } as never
}

beforeEach(() => {
  h.sendPresence.mockReset()
  h.sendPresence.mockResolvedValue(undefined)
})

describe('showUazapiTyping', () => {
  it('conta Meta: devolve false e não chama a Uazapi', async () => {
    const r = await showUazapiTyping(fakeDb({ config: { provider: 'meta' }, contact: null }), 'a', 'c')
    expect(r).toBe(false)
    expect(h.sendPresence).not.toHaveBeenCalled()
  })

  it('conta Uazapi: manda composing para o telefone do contato', async () => {
    const r = await showUazapiTyping(
      fakeDb({ config: { provider: 'uazapi', access_token: 'enc' }, contact: { phone: '+55 11 99999-9999' } }),
      'a',
      'c',
    )
    expect(r).toBe(true)
    expect(h.sendPresence).toHaveBeenCalledWith({ token: 'dec:enc', number: '5511999999999', delayMs: 25000 })
  })

  it('falha da Uazapi não vaza (a resposta da IA segue)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.sendPresence.mockRejectedValue(new Error('500'))
    const r = await showUazapiTyping(
      fakeDb({ config: { provider: 'uazapi', access_token: 'enc' }, contact: { phone: '5511999999999' } }),
      'a',
      'c',
    )
    expect(r).toBe(true)
    await new Promise((res) => setTimeout(res, 0))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
