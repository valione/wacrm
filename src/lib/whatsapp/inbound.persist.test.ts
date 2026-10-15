import { describe, it, expect, vi, beforeEach } from 'vitest'

// Regression coverage for Finding 2 of the migration-045 review: the shared
// `persistInboundMessage` pipeline (Meta, WAHA, Uazapi all funnel through
// it) previously had test coverage ONLY via the Meta webhook route test
// (`src/app/api/whatsapp/webhook/route.test.ts`), which always exercises a
// Meta-shaped payload. WAHA and Uazapi carry 100% of real traffic and never
// send `mediaType` / `waUserId` / `waParentUserId` / `waUsername` — those
// fields stay optional and unset for them. This file calls
// `persistInboundMessage` directly with a `NormalizedInboundMessage` shaped
// the way the Uazapi normalizer produces it, so a change that only "reads
// fine" for the Meta shape can't silently break the two providers that
// matter in production.
//
// Mocking style follows route.test.ts: a hoisted state bag the mocked
// `@supabase/supabase-js` client closes over, plus one vi.mock per
// downstream dependency `persistInboundMessage` fans out to.

const h = vi.hoisted(() => ({
  runAutomationsForTrigger: vi.fn(),
  dispatchInboundToFlows: vi.fn(),
  dispatchInboundToAiReply: vi.fn(),
  dispatchWebhookEvent: vi.fn(),
  state: {
    // Result the message upsert's .select() resolves to.
    messageUpsertResult: [{ id: 'msg-1' }] as { id: string }[],
    priorCustomerMsgCount: 0,
    conversation: { id: 'conv-1', unread_count: 0, account_id: 'acc-1' } as Record<
      string,
      unknown
    >,
    upsertCalls: [] as { row: Record<string, unknown>; options: unknown }[],
    rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
    // Counts every `.from('contacts')` call. The BSUID lookup
    // (`findContactByWaUserId`) is the only thing that ever reaches the
    // `contacts` table directly — the phone path goes through the mocked
    // `findExistingContact` dedupe helper instead — so this staying at 0
    // is what proves the BSUID branch was skipped, not just that it
    // happened to return nothing.
    contactsSelectCalls: 0,
  },
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      switch (table) {
        case 'conversations':
          // findOrCreateConversation: select().eq().eq().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: () =>
                      Promise.resolve({
                        data: [h.state.conversation],
                        error: null,
                      }),
                  }),
                }),
              }),
            }),
          }
        case 'broadcast_recipients':
          // flagBroadcastReplyIfAny: select().eq().eq().in().order().limit()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  in: () => ({
                    order: () => ({
                      limit: () => Promise.resolve({ data: [], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }
        case 'contacts':
          h.state.contactsSelectCalls++
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }
        case 'messages':
          return {
            // Two different chains land here, told apart by the count
            // option: the prior-message count (head request) and the
            // reply-context parent lookup (unused in this test — the
            // Uazapi message carries no replyToExternalId).
            select: (_columns: string, options?: { head?: boolean }) =>
              options?.head
                ? {
                    eq: () => ({
                      eq: () =>
                        Promise.resolve({
                          count: h.state.priorCustomerMsgCount,
                          error: null,
                        }),
                    }),
                  }
                : {
                    eq: () => ({
                      eq: () => ({
                        maybeSingle: () =>
                          Promise.resolve({ data: null, error: null }),
                      }),
                    }),
                  },
            // Idempotent insert: upsert(...).select('id')
            upsert: (row: Record<string, unknown>, options: unknown) => {
              h.state.upsertCalls.push({ row, options })
              return {
                select: () =>
                  Promise.resolve({
                    data: h.state.messageUpsertResult,
                    error: null,
                  }),
              }
            },
          }
        default:
          throw new Error(`unexpected table: ${table}`)
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: null, error: null })
    },
  }),
}))

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })),
  isUniqueViolation: () => false,
}))

vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: h.runAutomationsForTrigger,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: h.dispatchInboundToFlows,
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: h.dispatchInboundToAiReply,
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))

import { persistInboundMessage, type NormalizedInboundMessage } from './inbound'
import { findExistingContact } from '@/lib/contacts/dedupe'

const mockFindExistingContact = vi.mocked(findExistingContact)

beforeEach(() => {
  vi.clearAllMocks()
  h.state.messageUpsertResult = [{ id: 'msg-1' }]
  h.state.priorCustomerMsgCount = 0
  h.state.conversation = { id: 'conv-1', unread_count: 0, account_id: 'acc-1' }
  h.state.upsertCalls = []
  h.state.rpcCalls = []
  h.state.contactsSelectCalls = 0
  mockFindExistingContact.mockResolvedValue({
    id: 'contact-1',
    name: 'Ada',
    phone: '15551230000',
  })
  h.dispatchInboundToFlows.mockResolvedValue({ consumed: false })
  h.dispatchInboundToAiReply.mockResolvedValue(undefined)
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
  h.runAutomationsForTrigger.mockResolvedValue(undefined)
})

/**
 * Shaped exactly as the Uazapi normalizer produces it: `mediaType`,
 * `waUserId`, `waParentUserId` and `waUsername` are all optional on
 * `NormalizedInboundMessage` and Uazapi (like WAHA) never sets them —
 * it addresses purely by phone.
 */
function uazapiMessage(
  overrides: Partial<NormalizedInboundMessage> = {}
): NormalizedInboundMessage {
  return {
    externalId: 'uaz-msg-1',
    fromPhone: '15551230000',
    contactName: 'Ada',
    contentType: 'text',
    contentText: 'oi',
    mediaUrl: null,
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    replyToExternalId: null,
    interactiveReplyId: null,
    fromMe: false,
    ...overrides,
  }
}

describe('persistInboundMessage: QR-provider shape (Uazapi/WAHA, #367/#519)', () => {
  it('finds the contact by phone, skips the BSUID lookup, persists the message, and bumps unread exactly once', async () => {
    await persistInboundMessage(uazapiMessage(), 'acc-1', 'user-1', 0)

    // Contact resolved via the phone-dedupe helper.
    expect(mockFindExistingContact).toHaveBeenCalledWith(
      expect.anything(),
      'acc-1',
      '15551230000'
    )
    // The BSUID branch (findContactByWaUserId) never runs a `contacts`
    // query at all — there's no waUserId on this message, so it must be
    // skipped entirely rather than looked up with an empty value.
    expect(h.state.contactsSelectCalls).toBe(0)

    // Message persisted through the idempotent upsert.
    expect(h.state.upsertCalls).toHaveLength(1)
    expect(h.state.upsertCalls[0].row).toMatchObject({
      conversation_id: 'conv-1',
      message_id: 'uaz-msg-1',
      content_text: 'oi',
    })

    // Atomic unread bump RPC called exactly once.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.state.rpcCalls[0].name).toBe('bump_conversation_on_inbound')
  })
})
