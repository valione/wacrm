import { describe, it, expect } from 'vitest'
import {
  firstName,
  applySignature,
  signOutboundText,
  resolveSignatureName,
  MAX_SIGNATURE_NAME,
} from './signature'

describe('firstName', () => {
  it('takes the first word of a display name', () => {
    expect(firstName('Marcos Silva Pereira')).toBe('Marcos')
  })

  it('handles a single-word name', () => {
    expect(firstName('Marcos')).toBe('Marcos')
  })

  it('tolerates padding and repeated spaces', () => {
    expect(firstName('  Marcos   Silva ')).toBe('Marcos')
  })

  it('returns null when there is nothing usable', () => {
    expect(firstName(null)).toBeNull()
    expect(firstName(undefined)).toBeNull()
    expect(firstName('')).toBeNull()
    expect(firstName('   ')).toBeNull()
  })
})

describe('applySignature', () => {
  it('prefixes a bold name line', () => {
    expect(applySignature('Bom dia!', 'Marcos')).toBe('*Marcos*\nBom dia!')
  })

  it('is idempotent — never stacks the same signature twice', () => {
    const once = applySignature('Bom dia!', 'Marcos')
    expect(applySignature(once, 'Marcos')).toBe(once)
  })

  it('still signs when a DIFFERENT agent replies to a signed body', () => {
    // Not a real send path, but proves the idempotence check is
    // keyed on the actual name rather than "starts with an asterisk".
    expect(applySignature('*Marcos*\nBom dia!', 'Ana')).toBe(
      '*Ana*\n*Marcos*\nBom dia!',
    )
  })
})

describe('resolveSignatureName', () => {
  it('prefers the persona over the real name', () => {
    expect(resolveSignatureName('Ana', 'Marcos Silva')).toBe('Ana')
  })

  it('keeps a multi-word persona intact', () => {
    expect(resolveSignatureName('Ana | Atendimento', 'Marcos Silva')).toBe(
      'Ana | Atendimento',
    )
  })

  it('falls back to the first name when the persona is unset or blank', () => {
    expect(resolveSignatureName(null, 'Marcos Silva')).toBe('Marcos')
    expect(resolveSignatureName('', 'Marcos Silva')).toBe('Marcos')
    expect(resolveSignatureName('   ', 'Marcos Silva')).toBe('Marcos')
  })

  it('strips WhatsApp markup that would break the bold wrapper', () => {
    expect(resolveSignatureName('*Ana*', null)).toBe('Ana')
    expect(resolveSignatureName('An_a~`', null)).toBe('Ana')
  })

  it('collapses line breaks so the signature stays on one line', () => {
    expect(resolveSignatureName('Ana\nSuporte', null)).toBe('Ana Suporte')
  })

  it('caps the length at the DB limit', () => {
    const long = 'A'.repeat(MAX_SIGNATURE_NAME + 20)
    expect(resolveSignatureName(long, null)).toHaveLength(MAX_SIGNATURE_NAME)
  })

  it('returns null when neither source is usable', () => {
    expect(resolveSignatureName(null, null)).toBeNull()
    expect(resolveSignatureName('***', '  ')).toBeNull()
  })
})

describe('signOutboundText', () => {
  const on = { enabled: true, fullName: 'Marcos Silva' }

  it('signs plain text', () => {
    expect(
      signOutboundText({ ...on, text: 'Bom dia!', messageType: 'text' }),
    ).toBe('*Marcos*\nBom dia!')
  })

  it('signs a media caption', () => {
    expect(
      signOutboundText({ ...on, text: 'Segue a proposta', messageType: 'image' }),
    ).toBe('*Marcos*\nSegue a proposta')
  })

  it('leaves media without a caption alone', () => {
    expect(
      signOutboundText({ ...on, text: null, messageType: 'image' }),
    ).toBeNull()
    expect(
      signOutboundText({ ...on, text: '   ', messageType: 'document' }),
    ).toBe('   ')
  })

  it('never touches templates or interactive messages', () => {
    expect(
      signOutboundText({ ...on, text: 'Olá {{1}}', messageType: 'template' }),
    ).toBe('Olá {{1}}')
    expect(
      signOutboundText({ ...on, text: 'Escolha uma opção', messageType: 'interactive' }),
    ).toBe('Escolha uma opção')
  })

  it('passes through when the agent has signing off', () => {
    expect(
      signOutboundText({
        text: 'Bom dia!',
        messageType: 'text',
        enabled: false,
        fullName: 'Marcos Silva',
      }),
    ).toBe('Bom dia!')
  })

  it('signs with the persona when one is set', () => {
    expect(
      signOutboundText({
        ...on,
        text: 'Bom dia!',
        messageType: 'text',
        signatureName: 'Ana',
      }),
    ).toBe('*Ana*\nBom dia!')
  })

  it('passes through when the profile has no usable name', () => {
    expect(
      signOutboundText({
        text: 'Bom dia!',
        messageType: 'text',
        enabled: true,
        fullName: '  ',
      }),
    ).toBe('Bom dia!')
  })
})
