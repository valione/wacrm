import { describe, expect, it } from 'vitest'
import { isWhatsAppConfigured } from './config-status'

describe('isWhatsAppConfigured', () => {
  it('Meta: configurado quando tem phone_number_id', () => {
    expect(isWhatsAppConfigured({ phone_number_id: '123', provider_session: null })).toBe(true)
  })

  it('Uazapi/WAHA (QR Code): configurado pela sessão, sem phone_number_id', () => {
    expect(isWhatsAppConfigured({ phone_number_id: null, provider_session: 'wacrm_a1' })).toBe(true)
  })

  it('sem linha ou sem nenhum dos dois: não configurado', () => {
    expect(isWhatsAppConfigured(null)).toBe(false)
    expect(isWhatsAppConfigured({ phone_number_id: null, provider_session: null })).toBe(false)
  })
})
