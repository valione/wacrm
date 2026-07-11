// ============================================================
// Server-side audience resolution for POST /api/whatsapp/broadcasts.
//
// Adapted from the client-side `resolveAudience` in
// src/hooks/use-broadcast-sending.ts (~lines 155-206): same tables and
// filters, but the Supabase client is passed in by the caller (an
// admin/service-role client — RLS is bypassed, so every query here
// scopes explicitly `.eq('account_id', accountId)` instead of relying
// on `auth.uid()` policies) and there's no `csv` audience type — the
// wizard's CSV step upserts contacts in the browser as it does today
// and sends the resulting ids through `contact_ids`.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** Body shape accepted by `POST /api/whatsapp/broadcasts` for `audience`. */
export interface AudienceInput {
  type: 'all' | 'tags' | 'custom_field' | 'contact_ids'
  tagIds?: string[]
  excludeTagIds?: string[]
  /** `custom_fields.id` — equality match only (server-side has no is/is_not/contains operator). */
  field?: string
  value?: string
  contactIds?: string[]
}

/** Thrown on malformed `audience` input; routes map this to a 400. */
export class AudienceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AudienceError'
  }
}

// PostgREST's `.in(...)` filter has a practical cap around 1000
// values in a single request. Chunk any id list we build up from an
// intermediate query before feeding it back into `.in()`.
const IN_CHUNK = 500

async function contactIdsInAccount(
  db: SupabaseClient,
  accountId: string,
  candidateIds: string[],
): Promise<string[]> {
  if (candidateIds.length === 0) return []
  const unique = [...new Set(candidateIds)]
  const result = new Set<string>()
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const slice = unique.slice(i, i + IN_CHUNK)
    const { data, error } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .in('id', slice)
    if (error) throw new AudienceError(`Falha ao validar contatos: ${error.message}`)
    for (const row of data ?? []) result.add(row.id as string)
  }
  return [...result]
}

async function resolveAllAudience(db: SupabaseClient, accountId: string): Promise<string[]> {
  const { data, error } = await db.from('contacts').select('id').eq('account_id', accountId)
  if (error) throw new AudienceError(`Falha ao buscar contatos: ${error.message}`)
  return (data ?? []).map((row) => row.id as string)
}

async function resolveTagsAudience(
  db: SupabaseClient,
  accountId: string,
  tagIds: string[] | undefined,
): Promise<string[]> {
  if (!tagIds || tagIds.length === 0) return []
  const { data, error } = await db.from('contact_tags').select('contact_id').in('tag_id', tagIds)
  if (error) throw new AudienceError(`Falha ao buscar tags dos contatos: ${error.message}`)
  const candidateIds = (data ?? []).map((row) => row.contact_id as string)
  return contactIdsInAccount(db, accountId, candidateIds)
}

async function resolveCustomFieldAudience(
  db: SupabaseClient,
  accountId: string,
  field: string | undefined,
  value: string | undefined,
): Promise<string[]> {
  if (!field || value === undefined) {
    throw new AudienceError("audience.type 'custom_field' exige 'field' e 'value'.")
  }
  const { data, error } = await db
    .from('contact_custom_values')
    .select('contact_id')
    .eq('custom_field_id', field)
    .eq('value', value)
  if (error) throw new AudienceError(`Falha ao filtrar por campo personalizado: ${error.message}`)
  const candidateIds = (data ?? []).map((row) => row.contact_id as string)
  return contactIdsInAccount(db, accountId, candidateIds)
}

async function resolveContactIdsAudience(
  db: SupabaseClient,
  accountId: string,
  contactIds: string[] | undefined,
): Promise<string[]> {
  if (!contactIds || contactIds.length === 0) {
    throw new AudienceError("audience.type 'contact_ids' exige 'contactIds' não-vazio.")
  }
  return contactIdsInAccount(db, accountId, contactIds)
}

/**
 * Subtract contacts tagged with any of `excludeTagIds` from `ids`.
 * Mirrors the hook's exclude-tags step, applied after the base
 * audience is resolved (works the same way across every `type`).
 */
async function applyExcludeTags(
  db: SupabaseClient,
  ids: string[],
  excludeTagIds: string[] | undefined,
): Promise<string[]> {
  if (!excludeTagIds || excludeTagIds.length === 0 || ids.length === 0) return ids
  const { data, error } = await db
    .from('contact_tags')
    .select('contact_id')
    .in('tag_id', excludeTagIds)
  if (error) throw new AudienceError(`Falha ao aplicar exclusão de tags: ${error.message}`)
  const excluded = new Set((data ?? []).map((row) => row.contact_id as string))
  return ids.filter((id) => !excluded.has(id))
}

/**
 * Resolve `audience` into a deduplicated list of `contacts.id` scoped
 * to `accountId`. `db` is expected to be a service-role client (routes
 * pass `supabaseAdmin()`) since RLS is bypassed and every query below
 * scopes manually — do not pass a client whose queries aren't already
 * account-scoped by RLS unless you also trust these explicit filters.
 */
export async function resolveAudienceServer(
  db: SupabaseClient,
  accountId: string,
  audience: AudienceInput,
): Promise<string[]> {
  let ids: string[]
  switch (audience.type) {
    case 'all':
      ids = await resolveAllAudience(db, accountId)
      break
    case 'tags':
      ids = await resolveTagsAudience(db, accountId, audience.tagIds)
      break
    case 'custom_field':
      ids = await resolveCustomFieldAudience(db, accountId, audience.field, audience.value)
      break
    case 'contact_ids':
      ids = await resolveContactIdsAudience(db, accountId, audience.contactIds)
      break
    default:
      throw new AudienceError(`audience.type desconhecido: ${String((audience as { type?: unknown }).type)}`)
  }

  return applyExcludeTags(db, ids, audience.excludeTagIds)
}
