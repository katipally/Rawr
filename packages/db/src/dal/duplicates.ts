import { eq, sql } from 'drizzle-orm'
import { duplicateDismissal } from '../schema/records.ts'
import type { AccountContext } from './context.ts'
import { assertCanWrite } from './context.ts'
import { mutate, withAccount } from './index.ts'

/** B11. The queue that feeds the merge dialog.
 *
 *  `findDuplicate` in records.ts refuses a write whose email or domain already
 *  exists, which stops the obvious case and nothing else. Every duplicate that
 *  actually accumulates got in another way: two imports of the same portal a week
 *  apart, a form fill under a personal address, a company typed once as "Acme"
 *  and once as "Acme, Inc." The Notion setup guide names this as the one thing
 *  genuinely annoying to clean up after, and nothing here looked for it.
 *
 *  So: a scan, not a constraint. Every rule is one grouped statement over an
 *  index that already exists, capped, and each pair carries the reason it was
 *  proposed. Nothing merges on its own. A merge is irreversible, and a machine
 *  that decides two people are one person without asking is a machine that
 *  eventually deletes somebody real.
 *
 *  Cost: each rule is a single scan grouped on an expression, O(n log n) in the
 *  sort. At 88,000 contacts that is seconds, not minutes, which is why this is a
 *  request rather than a job. */

export type DuplicateRule =
  | 'same_address'
  | 'same_person_at_company'
  | 'same_name_and_company'
  | 'same_phone'
  | 'same_domain'
  | 'same_name_ignoring_suffix'

export type DuplicatePair = {
  rule: DuplicateRule
  /** Why these two are being proposed, in the words the reviewer needs to judge
   *  it: the value they share. */
  because: string
  /** The older record first, which is the one a merge should usually keep: it
   *  carries the longer timeline. The screen still lets the reviewer swap them. */
  keep: { id: string; displayName: string; createdAt: Date }
  absorb: { id: string; displayName: string; createdAt: Date }
}

type PairRow = {
  rule: string
  because: string
  a_id: string
  a_name: string
  a_created: Date
  b_id: string
  b_name: string
  b_created: Date
}

const asDate = (value: unknown): Date => (value instanceof Date ? value : new Date(String(value)))

/** The local part of an address with the noise that makes two spellings of one
 *  person look different removed: dots, and everything after a plus. Written as
 *  SQL rather than in TypeScript because the whole point is to group on it inside
 *  one statement rather than pull 88,000 rows out to compare them here. */
const CANONICAL_LOCAL = sql.raw(`
  replace(split_part(split_part(lower(c.email), '@', 1), '+', 1), '.', '')`)

const CONTACT_NAME = sql.raw(`
  trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))`)

/** The legal suffixes a company writes on one record and leaves off the next.
 *  Not an exhaustive list of company forms; the ones that actually turn up twice
 *  in a CRM. */
const LEGAL_SUFFIX = 'inc|llc|l\\.?l\\.?c|ltd|limited|corp|corporation|co|company|plc|gmbh|ag|bv|nv|sa|sas|srl|pty|group|holdings'

/** A company name with the things that differ between two spellings of it taken
 *  out: case, punctuation, a trailing legal suffix, and doubled spaces. */
const NORMALISED_COMPANY_NAME = (alias: string) =>
  sql.raw(`
    btrim(regexp_replace(
      btrim(regexp_replace(
        regexp_replace(lower(${alias}."name"), '[^a-z0-9 ]', ' ', 'g'),
        '\\s+', ' ', 'g')),
      '( (${LEGAL_SUFFIX}))+$', ''))`)

/** Every rule for contacts. Each returns the same shape, so the caller unions
 *  them and does no per-rule work. */
const CONTACT_RULES: { rule: DuplicateRule; query: (limit: number) => ReturnType<typeof sql> }[] = [
  {
    rule: 'same_address',
    query: (limit) => sql`
      select 'same_address' as rule, lower(c.email) as because,
             min(c.id::text) as a_id, max(c.id::text) as b_id
        from contact c
       where c.deleted_at is null and c.email is not null and c.email <> ''
       group by lower(c.email)
      having count(*) > 1
       limit ${limit}`,
  },
  {
    rule: 'same_person_at_company',
    query: (limit) => sql`
      select 'same_person_at_company' as rule,
             ${CANONICAL_LOCAL} || '@' || split_part(lower(c.email), '@', 2) as because,
             min(c.id::text) as a_id, max(c.id::text) as b_id
        from contact c
       where c.deleted_at is null and c.email is not null and c.email <> ''
       group by ${CANONICAL_LOCAL} || '@' || split_part(lower(c.email), '@', 2)
      having count(*) > 1
       limit ${limit}`,
  },
  {
    rule: 'same_name_and_company',
    query: (limit) => sql`
      select 'same_name_and_company' as rule,
             ${CONTACT_NAME} || ' at ' || coalesce(co.name, 'no company') as because,
             min(c.id::text) as a_id, max(c.id::text) as b_id
        from contact c left join company co on co.id = c.company_id
       where c.deleted_at is null
         and ${CONTACT_NAME} <> ''
         and c.company_id is not null
       group by ${CONTACT_NAME}, co.name, c.company_id
      having count(*) > 1
       limit ${limit}`,
  },
  {
    rule: 'same_phone',
    query: (limit) => sql`
      select 'same_phone' as rule, regexp_replace(c.phone, '[^0-9]', '', 'g') as because,
             min(c.id::text) as a_id, max(c.id::text) as b_id
        from contact c
       where c.deleted_at is null and c.phone is not null
         and length(regexp_replace(c.phone, '[^0-9]', '', 'g')) >= 7
       group by regexp_replace(c.phone, '[^0-9]', '', 'g')
      having count(*) > 1
       limit ${limit}`,
  },
]

const COMPANY_RULES: { rule: DuplicateRule; query: (limit: number) => ReturnType<typeof sql> }[] = [
  {
    rule: 'same_domain',
    query: (limit) => sql`
      select 'same_domain' as rule, lower(c.domain) as because,
             min(c.id::text) as a_id, max(c.id::text) as b_id
        from company c
       where c.deleted_at is null and c.domain is not null and c.domain <> ''
       group by lower(c.domain)
      having count(*) > 1
       limit ${limit}`,
  },
  {
    // "Acme" against "Acme, Inc." Deliberately an exact match on a normalised name
    // rather than trigram similarity: the first version of this used
    // `similarity() > 0.6` and proposed "Software Partner 1" against "Software
    // Partner 16", which are two companies that happen to share a stem. A reviewer
    // handed twenty-four of those stops reviewing, and the action on the other end
    // of this queue cannot be undone. Precision over recall, on purpose.
    //
    // Only pairs where neither carries a domain. A domain is the thing that tells
    // two similarly named companies apart, so two different ones are evidence
    // against a merge rather than for it, and two identical ones are already the
    // rule above.
    rule: 'same_name_ignoring_suffix',
    query: (limit) => sql`
      select 'same_name_ignoring_suffix' as rule,
             a.name || ' and ' || b.name as because,
             least(a.id::text, b.id::text) as a_id, greatest(a.id::text, b.id::text) as b_id
        from company a join company b
          on b.id > a.id
         and b.deleted_at is null
         and ${NORMALISED_COMPANY_NAME('b')} = ${NORMALISED_COMPANY_NAME('a')}
       where a.deleted_at is null
         and a.name is not null and b.name is not null
         and ${NORMALISED_COMPANY_NAME('a')} <> ''
         and coalesce(a.domain, '') = '' and coalesce(b.domain, '') = ''
       limit ${limit}`,
  },
]

const REASON: Record<DuplicateRule, (because: string) => string> = {
  same_address: (value) => `Both are ${value}`,
  same_person_at_company: (value) => `Both read as ${value} once dots and plus tags are ignored`,
  same_name_and_company: (value) => `Both are ${value}`,
  same_phone: (value) => `Both carry the number ${value}`,
  same_domain: (value) => `Both are ${value}`,
  same_name_ignoring_suffix: (value) => `The same name once the company form is ignored: ${value}`,
}

/** The same two records however the screen showed them. The queue puts the older
 *  one first and the reviewer may swap them, so the pair is keyed on the ids in
 *  a fixed order rather than on which side each was on. */
const ordered = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a])

/** Somebody decided these two are two people. Idempotent: a second click, or the
 *  same pair proposed again later by a different rule, writes nothing new.
 *
 *  Nothing is taught to the finder by this. A rule that adjusts itself out of a
 *  dismissal is a rule nobody can predict, and the action at the other end of
 *  this queue cannot be undone. */
export const dismissDuplicate = async (
  ctx: AccountContext,
  objectKey: 'contact' | 'company',
  pair: { leftId: string; rightId: string },
): Promise<void> =>
  mutate(ctx, objectKey, async (tx) => {
    const [leftId, rightId] = ordered(pair.leftId, pair.rightId)
    await tx
      .insert(duplicateDismissal)
      .values({ accountId: ctx.accountId, entityType: objectKey, leftId, rightId, dismissedBy: ctx.actorId })
      .onConflictDoNothing()
    return {
      result: undefined,
      audit: {
        entity: 'duplicate_dismissal',
        entityId: leftId,
        action: 'create',
        before: null,
        after: { object: objectKey, notTheSameAs: rightId },
      },
    }
  })

/** Likely duplicate pairs, newest rule first, capped.
 *
 *  Read-only, but gated on write: this is the queue for an irreversible action
 *  and it lists two records side by side with the reason they might be the same
 *  person. A viewer has no use for it and no business seeing it framed that way. */
export const findDuplicates = async (
  ctx: AccountContext,
  objectKey: 'contact' | 'company',
  options: { limit?: number } = {},
): Promise<DuplicatePair[]> => {
  assertCanWrite(ctx, objectKey)
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const rules = objectKey === 'contact' ? CONTACT_RULES : COMPANY_RULES

  return withAccount(ctx, async (tx) => {
    // Every pair already set aside, read once and used as the skip set the rules
    // fill in beside it: one bounded query rather than a lookup per proposal.
    const dismissed = await tx
      .select({ leftId: duplicateDismissal.leftId, rightId: duplicateDismissal.rightId })
      .from(duplicateDismissal)
      .where(eq(duplicateDismissal.entityType, objectKey))
    const seen = new Set(dismissed.map((row) => `${row.leftId}:${row.rightId}`))
    const out: DuplicatePair[] = []

    for (const found of rules) {
      if (out.length >= limit) break
      // Names are joined back on rather than selected in the group, because a
      // grouped query cannot carry a column it did not group by and repeating the
      // whole name expression in the GROUP BY is how the two drift apart.
      const rows = await tx.execute<PairRow>(sql`
        with pair as (${found.query(limit - out.length)})
        select pair.rule, pair.because,
               pair.a_id, pair.b_id,
               ${sql.raw(objectKey === 'contact' ? `trim(coalesce(a."first_name", '') || ' ' || coalesce(a."last_name", ''))` : `a."name"`)} as a_name,
               a.created_at as a_created,
               ${sql.raw(objectKey === 'contact' ? `trim(coalesce(b."first_name", '') || ' ' || coalesce(b."last_name", ''))` : `b."name"`)} as b_name,
               b.created_at as b_created
          from pair
          join ${sql.raw(`"${objectKey}"`)} a on a.id = pair.a_id::uuid
          join ${sql.raw(`"${objectKey}"`)} b on b.id = pair.b_id::uuid`)

      for (const row of rows) {
        // One pair per two records, whichever rule proposed it first. Somebody
        // reviewing the same two people four times because they share a name, an
        // address, a phone and a company stops reviewing.
        const key = [row.a_id, row.b_id].sort().join(':')
        if (seen.has(key)) continue
        seen.add(key)

        const a = { id: row.a_id, displayName: row.a_name?.trim() || row.a_id, createdAt: asDate(row.a_created) }
        const b = { id: row.b_id, displayName: row.b_name?.trim() || row.b_id, createdAt: asDate(row.b_created) }
        const [keep, absorb] = a.createdAt <= b.createdAt ? [a, b] : [b, a]
        out.push({
          rule: row.rule as DuplicateRule,
          because: REASON[row.rule as DuplicateRule](row.because),
          keep,
          absorb,
        })
      }
    }

    return out.slice(0, limit)
  })
}

export type JunkCompany = { id: string; name: string; createdAt: Date; contactCount: number }

/** Companies named after a HubSpot company id rather than a company: a bare
 *  export like "58242052997" from a contact whose real employer in HubSpot had
 *  already been merged or deleted. Read-only and lists every one there is,
 *  because a person decides record by record whether it is safe to delete;
 *  nothing here does that for them. */
export const findJunkCompanies = async (ctx: AccountContext, options: { limit?: number } = {}): Promise<JunkCompany[]> => {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  return withAccount(ctx, (tx) =>
    tx.execute<{ id: string; name: string; created_at: Date; contact_count: number }>(sql`
      select co.id, co.name, co.created_at,
             (select count(*)::int from contact c where c.company_id = co.id and c.deleted_at is null) as contact_count
        from company co
       where co.deleted_at is null and co.name ~ '^[0-9]+$'
       order by co.created_at desc
       limit ${limit}`),
  ).then((rows) =>
    rows.map((row) => ({ id: row.id, name: row.name, createdAt: asDate(row.created_at), contactCount: row.contact_count })),
  )
}
