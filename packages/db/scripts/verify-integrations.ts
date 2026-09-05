import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import type { Role, WorkspaceContext } from '../src/dal/context.ts'
import {
  claimForReplay,
  claimInbound,
  INTEGRATION_KINDS,
  disconnectIntegration,
  listIntegrations,
  listUnmatchedEvents,
  once,
  readCredentials,
  recordHealth,
  rematchInbound,
  saveIntegration,
} from '../src/dal/integrations.ts'
import {
  createWebhookEndpoint,
  endpointsFor,
  listWebhookEndpoints,
  recordDelivery,
  removeWebhookEndpoint,
  rollWebhookSecret,
  updateWebhookEndpoint,
} from '../src/dal/webhooks.ts'
import { acceptSuggestion, applyEnrichment, markSource } from '../src/dal/enrichment.ts'
import { listSuggestions, readFieldSources } from '../src/dal/integrations.ts'
import {
  ingestMarketingEvent,
  mailableContacts,
  readSegmentContactPage,
  setExternalId,
} from '../src/dal/marketing-events.ts'
import { evaluateSegment, listSegments, saveSegment } from '../src/dal/segments.ts'
import {
  addBlocklistEntry,
  blockedPatterns,
  disconnectMailbox,
  ingestMessage,
  listMailboxes,
  readMailbox,
  removeBlocklistEntry,
  saveMailbox,
  shouldSkip,
  threadsForContact,
  updateMailboxCursor,
  type IncomingMessage,
  internalDomainOf,
} from '../src/dal/messages.ts'
import { createRecord, getRecord } from '../src/dal/records.ts'
import { createImportRun, readImportRun, runImportChunk, setImportMapping } from '../src/dal/imports.ts'
import { readTimeline } from '../src/dal/activity.ts'
import { listFields } from '../src/dal/admin-fields.ts'
import { readSubscriptions } from '../src/dal/subscriptions.ts'
import { recordDeadLetter } from '../src/dal/jobs.ts'
import { closeAppPool } from '../src/internal/pool.ts'

/** F6's definition of done, plus F1 phase B, run against the real database.
 *
 *  The provider calls themselves live in the web app; what is checked here is
 *  everything that decides what is stored, who it belongs to, what is refused and
 *  what a retry does. That is where the promises are. */

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })
const db = drizzle(owner, { schema: s })

let failures = 0
const pass = (what: string, detail = '') => console.log(`PASS  ${what}${detail ? `  ${detail}` : ''}`)
const fail = (what: string, detail: string) => {
  failures += 1
  console.log(`FAIL  ${what}\n      ${detail}`)
}

const check = async (what: string, fn: () => Promise<string | undefined>): Promise<void> => {
  try {
    const detail = await fn()
    pass(what, detail ?? '')
  } catch (cause) {
    fail(what, cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause))
  }
}

const expect = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message)
}

const refuses = async (what: string, fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  throw new Error(`${what} was allowed and should not have been`)
}

const stamp = Math.random().toString(36).slice(2, 8)

try {
  const [datasaur] = await db.select().from(s.workspace).where(eq(s.workspace.slug, 'datasaur'))
  const [probe] = await db.select().from(s.workspace).where(eq(s.workspace.slug, 'probe'))
  if (!datasaur || !probe) throw new Error('Run pnpm db:seed first.')

  const members = await db
    .select({ id: s.userAccount.id, email: s.userAccount.email, role: s.membership.role })
    .from(s.membership)
    .innerJoin(s.userAccount, eq(s.userAccount.id, s.membership.userId))
    .where(eq(s.membership.workspaceId, datasaur.id))

  const ctxFor = (role: Role): WorkspaceContext => {
    const member = members.find((m) => m.role === role)
    if (!member) throw new Error(`no seeded ${role}`)
    return { workspaceId: datasaur.id, actorId: member.id, actorKind: 'user', role }
  }

  const admin = ctxFor('admin')
  const sales = ctxFor('sales')
  const viewer = ctxFor('viewer')
  const probeCtx: WorkspaceContext = { workspaceId: probe.id, actorId: null, actorKind: 'user', role: 'admin' }
  const salesUser = members.find((m) => m.role === 'sales')!

  console.log('-- the framework -----------------------------------------------')

  await check('every known integration has a row, configured or not', async () => {
    const rows = await listIntegrations(admin)
    expect(rows.length === INTEGRATION_KINDS.length, `${rows.length} kinds listed, ${INTEGRATION_KINDS.length} known`)
    for (const kind of INTEGRATION_KINDS) {
      expect(rows.some((row) => row.kind === kind), `${kind} has no row`)
    }
    const missing = rows.find((row) => row.state === 'not_configured')
    expect(Boolean(missing), 'nothing reads as not configured, so an absent integration is invisible')
    return `${rows.length} kinds, ${rows.filter((row) => row.state === 'not_configured').length} not configured`
  })

  await check('a credential is stored encrypted and never returned in the list', async () => {
    await saveIntegration(admin, { kind: 'brevo', config: { listId: 42 }, secret: `verify-${stamp}` })
    const rows = await listIntegrations(admin)
    const brevo = rows.find((row) => row.kind === 'brevo')
    expect(brevo?.hasSecret === true, 'the secret was not stored')
    expect(!JSON.stringify(brevo).includes(stamp), 'the secret leaked into the list payload')

    const [raw] = await db.execute<{ secret_ref: string }>(
      sql`select secret_ref from integration where workspace_id = ${datasaur.id} and kind = 'brevo'`,
    )
    expect(!raw!.secret_ref.includes(stamp), 'the secret is in the database in plain text')
    return 'the column holds ciphertext, the list holds a boolean'
  })

  await check('and it decrypts for a call that is about to be made', async () => {
    const creds = await readCredentials(admin, 'brevo')
    expect(creds?.secret === `verify-${stamp}`, 'the secret did not round-trip')
    expect(creds?.config.listId === 42, 'the config did not round-trip')
    return 'decrypted only here'
  })

  await check('saving a config change keeps the stored key', async () => {
    await saveIntegration(admin, { kind: 'brevo', config: { listId: 43 } })
    const creds = await readCredentials(admin, 'brevo')
    expect(creds?.secret === `verify-${stamp}`, 'the key was lost when only the config changed')
    expect(creds?.config.listId === 43, 'the config did not change')
    return 'nobody has to re-type a credential they cannot read back'
  })

  await check('a rejected credential reads as disconnected, not degraded', async () => {
    await recordHealth(admin, 'brevo', { ok: false, error: 'Brevo said 401.', disconnected: true })
    const rows = await listIntegrations(admin)
    const brevo = rows.find((row) => row.kind === 'brevo')
    expect(brevo?.state === 'disconnected', `state is ${brevo?.state}`)
    expect(brevo?.lastError === 'Brevo said 401.', 'the provider’s own error was not kept')
    return 'retrying stops; a new key is what fixes it'
  })

  await check('a success clears the error and turns it green', async () => {
    await recordHealth(admin, 'brevo', { ok: true })
    const rows = await listIntegrations(admin)
    const brevo = rows.find((row) => row.kind === 'brevo')
    expect(brevo?.state === 'connected', `state is ${brevo?.state}`)
    expect(brevo?.lastError === null, 'the old error is still on screen')
    return 'connected, with a last-succeeded time'
  })

  await check('a viewer cannot change a credential', async () =>
    refuses('a viewer saving an integration', () =>
      saveIntegration(viewer, { kind: 'apollo', secret: 'nope' }),
    ),
  )

  console.log('')
  console.log('-- idempotency and deduplication -------------------------------')

  let calls = 0

  await check('an outbound call runs once per key', async () => {
    const key = `verify:${stamp}:push`
    const first = await once(admin, { key, operation: 'verify.push' }, async () => {
      calls += 1
      return { sent: true }
    })
    const second = await once(admin, { key, operation: 'verify.push' }, async () => {
      calls += 1
      return { sent: true }
    })
    expect(calls === 1, `the work ran ${calls} times`)
    expect(first.fresh && !second.fresh, 'the second call did not report as a replay')
    return 'a retry returns the first answer instead of sending again'
  })

  await check('and a different key is a different call', async () => {
    await once(admin, { key: `verify:${stamp}:other`, operation: 'verify.push' }, async () => {
      calls += 1
      return { sent: true }
    })
    expect(calls === 2, `${calls} calls`)
    return 'the same words twice on purpose still works'
  })

  await check('an inbound event is claimed once', async () => {
    const input = {
      source: 'verify',
      providerEventId: `evt-${stamp}`,
      kind: 'open',
      payload: { email: 'nobody@verify.example' },
    }
    const first = await claimInbound(admin, input)
    const second = await claimInbound(admin, input)
    expect(first && !second, 'a webhook delivered twice was processed twice')
    return 'deduplicated on the provider’s own event id'
  })

  console.log('')
  console.log('-- marketing events on the timeline ----------------------------')

  const trackedEmail = `verify-tracked-${stamp}@partner1.example`
  let trackedId = ''

  await check('an open lands on the right contact', async () => {
    const created = await createRecord(admin, 'contact', {
      first_name: 'Verify',
      last_name: 'Tracked',
      email: trackedEmail,
    })
    trackedId = created.id

    const outcome = await ingestMarketingEvent(admin, {
      source: 'apollo',
      providerEventId: `open-${stamp}`,
      kind: 'open',
      email: trackedEmail,
      subject: 'The pilot scope',
      at: new Date(),
      detail: {},
    })
    expect(outcome.stored && outcome.matched, outcome.reason ?? 'not stored')

    const timeline = await readTimeline(admin, {
      entity: { entityType: 'contact', entityId: trackedId },
      types: ['email_tracking'],
    })
    expect(timeline.rows.length === 1, `${timeline.rows.length} tracking entries`)
    return timeline.rows[0]!.subject ?? ''
  })

  await check('the same event twice is one entry', async () => {
    await ingestMarketingEvent(admin, {
      source: 'apollo',
      providerEventId: `open-${stamp}`,
      kind: 'open',
      email: trackedEmail,
      subject: 'The pilot scope',
      at: new Date(),
      detail: {},
    })
    const timeline = await readTimeline(admin, {
      entity: { entityType: 'contact', entityId: trackedId },
      types: ['email_tracking'],
    })
    expect(timeline.rows.length === 1, `${timeline.rows.length} entries after a duplicate delivery`)
    return 'the provider can retry safely'
  })

  await check('an event for nobody is kept, not dropped', async () => {
    const outcome = await ingestMarketingEvent(admin, {
      source: 'apollo',
      providerEventId: `orphan-${stamp}`,
      kind: 'click',
      email: `stranger-${stamp}@nowhere.example`,
      subject: 'A campaign',
      at: new Date(),
      detail: {},
    })
    expect(outcome.stored && !outcome.matched, 'an unmatched event was dropped')
    const unmatched = await listUnmatchedEvents(admin)
    expect(
      unmatched.some((row) => (row.payload as { email?: string }).email === `stranger-${stamp}@nowhere.example`),
      'it is not in the unmatched queue',
    )
    return '"we could not tell who opened it" is a different answer from "nobody did"'
  })

  await check('and it finds its owner once that person becomes a contact', async () => {
    await createRecord(admin, 'contact', {
      first_name: 'Verify',
      last_name: 'Stranger',
      email: `stranger-${stamp}@nowhere.example`,
    })
    const result = await rematchInbound(admin)
    expect(result.matched >= 1, `${result.matched} matched`)
    return `${result.matched} event(s) found an owner`
  })

  await check('an unsubscribe is authoritative and stops future pushes', async () => {
    await ingestMarketingEvent(admin, {
      source: 'brevo',
      providerEventId: `unsub-${stamp}`,
      kind: 'unsubscribe',
      email: trackedEmail,
      subject: 'The newsletter',
      at: new Date(),
      detail: {},
    })
    const subscriptions = await readSubscriptions(admin, trackedId)
    const external = subscriptions.filter((row) => !row.isInternal)
    expect(
      external.every((row) => row.state === 'unsubscribed'),
      external.map((row) => `${row.name}=${row.state}`).join(', '),
    )

    const mailable = await mailableContacts(admin, [trackedId])
    expect(mailable.length === 0, 'somebody who opted out is still mailable')
    return 'nobody is mailed after opting out, in either direction'
  })

  let bulkSegmentId = ''

  await check('a push walks past the old two-hundred-row ceiling', async () => {
    // Two hundred and ten, because two hundred was the cap that silently truncated
    // a push and the seed has nowhere near enough contacts to cross it on its own.
    const marker = `bulkpush-${stamp}`
    await db.execute(sql`
      insert into contact (workspace_id, email, first_name, last_name)
      select ${datasaur.id}, ${marker} || n::text || '@example.test', 'Bulk', n::text
        from generate_series(1, 210) as n`)

    const created = await saveSegment(admin, {
      objectKey: 'contact',
      name: `Verify bulk ${stamp}`,
      filters: [{ conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: marker }] }],
    })
    bulkSegmentId = created.id
    await evaluateSegment(admin, created.id)

    let cursor: string | null = null
    let seen = 0
    let pages = 0
    do {
      const page = await readSegmentContactPage(admin, bulkSegmentId, { after: cursor, limit: 100 })
      seen += page.rows.length
      cursor = page.nextCursor
      pages += 1
      expect(pages < 10, 'the cursor is not advancing')
    } while (cursor)

    expect(seen === 210, `${seen} of 210 reached, so a push would leave the rest out`)
    return `${seen} across ${pages} pages`
  })

  await check('and leaves out an opt-out without dropping it from the count', async () => {
    const [row] = await db.execute<{ id: string }>(
      sql`select id from contact
           where workspace_id = ${datasaur.id} and email like ${'bulkpush-' + stamp + '%'}
           order by id limit 1`,
    )
    expect(Boolean(row), 'the bulk contacts are gone')
    const [type] = await db.execute<{ id: string }>(
      sql`select id from subscription_type
           where workspace_id = ${datasaur.id} and is_internal = false
           order by name limit 1`,
    )
    expect(Boolean(type), 'the workspace has no external subscription type')
    await db.execute(sql`
      insert into subscription_state (workspace_id, contact_id, subscription_type_id, state)
      values (${datasaur.id}, ${row!.id}, ${type!.id}, 'unsubscribed')
      on conflict (workspace_id, contact_id, subscription_type_id)
        do update set state = 'unsubscribed'`)

    const page = await readSegmentContactPage(admin, bulkSegmentId, { limit: 5 })
    const target = page.rows.find((candidate) => candidate.id === row!.id)
    expect(Boolean(target), 'the opted-out contact fell out of the page entirely')
    expect(target!.mailable === false, 'somebody who opted out is still mailable')
    return 'the row is returned and flagged, so skipped counts without a second scan'
  })

  await check('the provider’s own id is kept for the next sync', async () => {
    await setExternalId(admin, trackedId, 'brevo', `brevo-${stamp}`)
    const [row] = await db.execute<{ id: string }>(
      sql`select external_ids ->> 'brevo' as id from contact where id = ${trackedId}`,
    )
    expect(row?.id === `brevo-${stamp}`, 'the external id was not stored')
    return 'the sync is incremental rather than a full re-push'
  })

  console.log('')
  console.log('-- woodpecker, whose events are its own ------------------------')

  await check('saving Woodpecker mints a webhook token, and keeps it', async () => {
    await saveIntegration(admin, { kind: 'woodpecker', config: { campaignId: 101 }, secret: `wp-${stamp}` })
    const [first] = await db.execute<{ token: string | null }>(
      sql`select config ->> 'webhookToken' as token from integration
           where workspace_id = ${datasaur.id} and kind = 'woodpecker'`,
    )
    expect(typeof first?.token === 'string' && first.token.length >= 24, 'no token was minted')

    // A second save must not roll it: the URL is already pasted at Woodpecker.
    await saveIntegration(admin, { kind: 'woodpecker', config: { campaignId: 102 } })
    const [second] = await db.execute<{ token: string | null }>(
      sql`select config ->> 'webhookToken' as token from integration
           where workspace_id = ${datasaur.id} and kind = 'woodpecker'`,
    )
    expect(second?.token === first?.token, 'the token changed on a second save')
    return 'minted once, kept across saves'
  })

  await check('the same Woodpecker delivery twice writes one timeline entry', async () => {
    const before = await readTimeline(admin, { entity: { entityType: 'contact', entityId: trackedId }, limit: 100 })
    const event = {
      source: 'woodpecker' as const,
      providerEventId: `wp-open-${stamp}`,
      kind: 'open' as const,
      email: trackedEmail,
      subject: 'Development outbound',
      at: new Date(),
      detail: { campaignId: 101 },
    }
    const first = await ingestMarketingEvent(admin, event)
    const again = await ingestMarketingEvent(admin, event)
    expect(first.stored, 'the first delivery was not stored')
    expect(!again.stored, 'the retry was stored a second time')

    const after = await readTimeline(admin, { entity: { entityType: 'contact', entityId: trackedId }, limit: 100 })
    expect(after.rows.length === before.rows.length + 1, `${before.rows.length} then ${after.rows.length}`)
    return 'batched retries cost nothing, because the key is what the event is about'
  })

  console.log('')
  console.log('-- importing a HubSpot portal ----------------------------------')

  await check('notes land on the timeline of the contact they name', async () => {
    const email = trackedEmail
    const rows = [
      { 'Associated Contact': email, 'Activity Type': 'note', 'Note Body': 'Talked about pricing', 'Activity Date': '2026-08-01T10:00:00Z', 'Record ID': `hs-${stamp}-1` },
      { 'Associated Contact': email, 'Activity Type': 'email', Subject: 'Trial', 'Note Body': 'Sent the trial link', 'Activity Date': '2026-08-02T10:00:00Z', 'Record ID': `hs-${stamp}-2` },
    ]
    const run = await createImportRun(admin, {
      objectKey: 'contact',
      kind: 'activities',
      source: 'hubspot',
      filename: 'engagements.csv',
      headers: Object.keys(rows[0]!),
      rows,
      mapping: {},
    })
    // The preset is what maps them: nobody picked these columns by hand.
    expect(run.suggested['Associated Contact'] === 'contact_email', JSON.stringify(run.suggested))
    expect(run.suggested['Activity Date'] === 'occurred_at', JSON.stringify(run.suggested))

    await setImportMapping(admin, run.id, run.suggested)
    const outcome = await runImportChunk(admin, run.id)
    expect(outcome.done, 'the run did not finish')

    const [counted] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from activity
           where workspace_id = ${datasaur.id} and import_key like ${`hubspot:hs-${stamp}-%`}`,
    )
    expect(Number(counted?.n) === 2, `${counted?.n} activities written`)
    return 'two engagements, matched on the address in the file'
  })

  await check('importing the same export again changes nothing', async () => {
    const email = trackedEmail
    const rows = [
      { 'Associated Contact': email, 'Activity Type': 'note', 'Note Body': 'Talked about pricing', 'Activity Date': '2026-08-01T10:00:00Z', 'Record ID': `hs-${stamp}-1` },
      { 'Associated Contact': email, 'Activity Type': 'email', Subject: 'Trial', 'Note Body': 'Sent the trial link', 'Activity Date': '2026-08-02T10:00:00Z', 'Record ID': `hs-${stamp}-2` },
    ]
    const run = await createImportRun(admin, {
      objectKey: 'contact',
      kind: 'activities',
      source: 'hubspot',
      filename: 'engagements.csv',
      headers: Object.keys(rows[0]!),
      rows,
      mapping: {},
    })
    await setImportMapping(admin, run.id, run.suggested)
    await runImportChunk(admin, run.id)

    const [counted] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from activity
           where workspace_id = ${datasaur.id} and import_key like ${`hubspot:hs-${stamp}-%`}`,
    )
    expect(Number(counted?.n) === 2, `${counted?.n} activities after the second run`)
    return 'the import key is the file\u2019s own, so a re-run is a no-op'
  })

  await check('a note about somebody who is not here is reported, not invented', async () => {
    const rows = [
      { 'Associated Contact': `nobody-${stamp}@stranger.example`, 'Activity Type': 'note', 'Note Body': 'Who?', 'Activity Date': '2026-08-03T10:00:00Z', 'Record ID': `hs-${stamp}-3` },
    ]
    const run = await createImportRun(admin, {
      objectKey: 'contact',
      kind: 'activities',
      source: 'hubspot',
      filename: 'engagements.csv',
      headers: Object.keys(rows[0]!),
      rows,
      mapping: {},
    })
    await setImportMapping(admin, run.id, run.suggested)
    await runImportChunk(admin, run.id)

    const [counted] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from activity
           where workspace_id = ${datasaur.id} and import_key = ${`hubspot:hs-${stamp}-3`}`,
    )
    expect(Number(counted?.n) === 0, 'a contact was invented for an unmatched note')
    return 'no contact is created to hold an orphaned note'
  })

  await check('an activity file with no address is refused before it runs', async () =>
    refuses('an activity import with no contact column', () =>
      createImportRun(admin, {
        objectKey: 'contact',
        kind: 'activities',
        source: null,
        filename: 'notes.csv',
        headers: ['Body'],
        rows: [{ Body: 'something' }],
        mapping: {},
      }).then((run) => setImportMapping(admin, run.id, { Body: 'body' })),
    ),
  )

  console.log('')
  console.log('-- enrichment never overwrites a human -------------------------')

  let enrichContactId = ''

  await check('a blank field is filled and the provenance is recorded', async () => {
    const created = await createRecord(admin, 'contact', {
      first_name: 'Verify',
      last_name: 'Enrich',
      email: `verify-enrich-${stamp}@partner2.example`,
    })
    enrichContactId = created.id

    const result = await applyEnrichment(admin, {
      objectKey: 'contact',
      entityId: enrichContactId,
      provider: 'verify',
      values: { title: 'Head of Data' },
    })
    expect(result.written.includes('title'), JSON.stringify(result))

    const sources = await readFieldSources(admin, 'contact', enrichContactId)
    expect(sources.get('title')?.source === 'enrichment', 'the provenance was not recorded')
    return 'filled, and marked as enrichment'
  })

  await check('and a value whose provenance is enrichment can be updated', async () => {
    const result = await applyEnrichment(admin, {
      objectKey: 'contact',
      entityId: enrichContactId,
      provider: 'verify',
      values: { title: 'VP of Data' },
    })
    expect(result.written.includes('title'), JSON.stringify(result))
    return 'a provider may correct its own earlier answer'
  })

  await check('a value a human entered is never overwritten', async () => {
    await db.execute(sql`update contact set title = 'What A Person Typed' where id = ${enrichContactId}`)
    await db.transaction(async () => {})
    await applyEnrichment(admin, {
      objectKey: 'contact',
      entityId: enrichContactId,
      provider: 'verify',
      values: { phone: '+1 555 0000' },
    })
    // Mark the title as human, the way a form or an inline edit does.
    const [{ id: workspaceId } = { id: '' }] = [{ id: datasaur.id }]
    await db.execute(sql`
      insert into field_source (workspace_id, entity, entity_id, field_key, source)
      values (${workspaceId}, 'contact', ${enrichContactId}, 'title', 'human')
      on conflict (workspace_id, entity, entity_id, field_key)
      do update set source = 'human', provider = null`)

    const result = await applyEnrichment(admin, {
      objectKey: 'contact',
      entityId: enrichContactId,
      provider: 'verify',
      values: { title: 'Chief Something' },
    })
    expect(result.written.length === 0, `it wrote ${result.written.join(', ')}`)
    expect(result.suggested.includes('title'), 'the refused value was not kept as a suggestion')

    const record = await getRecord(admin, 'contact', enrichContactId)
    expect(record?.values.title === 'What A Person Typed', `the title is now ${String(record?.values.title)}`)
    return 'refused, and held where a person can see it'
  })

  await check('a refused value is visible rather than discarded', async () => {
    const suggestions = await listSuggestions(admin, 'contact', enrichContactId)
    const title = suggestions.find((row) => row.fieldKey === 'title')
    expect(Boolean(title), 'no suggestion was kept')
    expect(title!.current === 'What A Person Typed', 'the suggestion lost what it was compared against')
    return `${title!.provider} suggested "${title!.suggested}" against "${title!.current}"`
  })

  await check('accepting a suggestion makes it a human value', async () => {
    const suggestions = await listSuggestions(admin, 'contact', enrichContactId)
    const title = suggestions.find((row) => row.fieldKey === 'title')!
    await acceptSuggestion(admin, title.id)

    const record = await getRecord(admin, 'contact', enrichContactId)
    expect(record?.values.title === 'Chief Something', `the title is ${String(record?.values.title)}`)
    const sources = await readFieldSources(admin, 'contact', enrichContactId)
    expect(sources.get('title')?.source === 'human', 'accepting did not mark it as a human decision')

    const after = await applyEnrichment(admin, {
      objectKey: 'contact',
      entityId: enrichContactId,
      provider: 'verify',
      values: { title: 'Something Else Entirely' },
    })
    expect(after.written.length === 0, 'enrichment took back a value a person accepted')
    return 'a person’s decision is final'
  })

  await check('a provider returning nothing never blanks a field', async () => {
    const result = await applyEnrichment(admin, {
      objectKey: 'contact',
      entityId: enrichContactId,
      provider: 'verify',
      values: { title: null, phone: '' },
    })
    expect(result.written.length === 0, 'a null answer overwrote something')
    const record = await getRecord(admin, 'contact', enrichContactId)
    expect(record?.values.title === 'Chief Something', 'the title was blanked')
    return 'blank is correct; invented data is not, and neither is erasure'
  })

  await check('a form fill marks its fields so enrichment leaves them alone', async () => {
    await db.transaction(async (tx) => {
      await markSource(tx as never, admin, {
        entity: 'contact',
        entityId: enrichContactId,
        fieldKeys: ['first_name'],
        source: 'form',
      })
    })
    const result = await applyEnrichment(admin, {
      objectKey: 'contact',
      entityId: enrichContactId,
      provider: 'verify',
      values: { first_name: 'Renamed' },
    })
    expect(result.written.length === 0, 'enrichment overwrote what somebody typed into a form')
    return 'form, import and booking all count as a person'
  })

  console.log('')
  console.log('-- B9: the four files a portal exports that are not records ----')

  /** One run, start to finish, so a check reads as the thing it is checking
   *  rather than as four lines of the same plumbing. */
  const importFile = async (
    kind: 'properties' | 'associations' | 'lists' | 'submissions',
    rows: Record<string, string>[],
  ) => {
    const headers = Object.keys(rows[0] ?? {})
    const run = await createImportRun(admin, {
      objectKey: 'contact',
      kind,
      source: 'hubspot',
      filename: `verify-${kind}-${stamp}.csv`,
      headers,
      rows,
      mapping: {},
    })
    await setImportMapping(admin, run.id, run.suggested)
    for (let guard = 0; guard < 50; guard += 1) {
      const progress = await runImportChunk(admin, run.id)
      if (progress.done) break
    }
    const summary = await readImportRun(admin, run.id)
    if (!summary) throw new Error('the run vanished')
    return summary
  }

  await check('a property export creates the fields records need', async () => {
    const summary = await importFile('properties', [
      { 'Object': 'contact', 'Name': `Verify tier ${stamp}`, 'Internal name': `verify_tier_${stamp}`, 'Type': 'enumeration', 'Field type': 'select', 'Options': 'Gold;Silver;Bronze', 'Group name': 'Verify group' },
      { 'Object': 'company', 'Name': `Verify seats ${stamp}`, 'Internal name': `verify_seats_${stamp}`, 'Type': 'number', 'Field type': 'number', 'Options': '', 'Group name': 'Verify group' },
    ])
    expect(summary.errored === 0, summary.errors.map((row) => row.reason).join(' | '))
    expect(summary.created === 2, `${summary.created} created`)

    const fields = await listFields(admin, 'contact')
    const made = fields.find((field) => field.key === `verify_tier_${stamp}`)
    expect(Boolean(made), 'the contact property is not there')
    expect(made!.type === 'select', `type is ${made!.type}`)
    expect(made!.options.join(',') === 'Gold,Silver,Bronze', made!.options.join(','))
    expect(made!.groupName === 'Verify group', `group is ${made!.groupName}`)
    expect(made!.source === 'hubspot', `source is ${made!.source}`)
    return 'label, type, choices, group and where it came from all crossed'
  })

  await check('and re-running the same property file updates rather than duplicating', async () => {
    const summary = await importFile('properties', [
      { 'Object': 'contact', 'Name': `Verify tier ${stamp} renamed`, 'Internal name': `verify_tier_${stamp}`, 'Type': 'enumeration', 'Field type': 'select', 'Options': 'Gold;Silver', 'Group name': 'Verify group' },
    ])
    expect(summary.updated === 1, `${summary.updated} updated, ${summary.created} created`)
    const fields = await listFields(admin, 'contact')
    const matching = fields.filter((field) => field.key === `verify_tier_${stamp}`)
    expect(matching.length === 1, `${matching.length} fields carry that key`)
    expect(matching[0]!.label.endsWith('renamed'), 'the label did not follow')
    return 'the internal name is the identity, so a rename is a rename'
  })

  await check('a property Rawr ships is never relabelled by an import', async () => {
    const before = (await listFields(admin, 'contact')).find((field) => field.key === 'email')
    const summary = await importFile('properties', [
      { 'Object': 'contact', 'Name': 'Electronic mail', 'Internal name': 'email', 'Type': 'string', 'Field type': 'text', 'Options': '', 'Group name': '' },
    ])
    expect(summary.skipped === 1, `${summary.skipped} skipped, ${summary.updated} updated`)
    const after = (await listFields(admin, 'contact')).find((field) => field.key === 'email')
    expect(after?.label === before?.label, `Email is now called ${after?.label}`)
    return 'a system field keeps the meaning a dozen screens depend on'
  })

  await check('a deal arrives with its people on it', async () => {
    const [seededPipeline] = await db.execute<{ pipeline_id: string; stage_id: string }>(sql`
      select p.id as pipeline_id, s.id as stage_id
        from pipeline p join pipeline_stage s on s.pipeline_id = p.id
       where p.workspace_id = ${datasaur.id}
       order by p.name, s.position limit 1`)
    expect(Boolean(seededPipeline), 'the workspace has no pipeline to put a deal in')
    const deal = await createRecord(admin, 'deal', {
      name: `Verify assoc deal ${stamp}`,
      pipeline_id: seededPipeline!.pipeline_id,
      stage_id: seededPipeline!.stage_id,
    })
    const contact = await createRecord(admin, 'contact', { email: `assoc-${stamp}@example.test`, first_name: 'Assoc' })
    const summary = await importFile('associations', [
      { 'Deal name': `Verify assoc deal ${stamp}`, 'Contact email': `assoc-${stamp}@example.test`, 'Association label': 'Decision maker' },
    ])
    expect(summary.errored === 0, summary.errors.map((row) => row.reason).join(' | '))
    expect(summary.created === 1, `${summary.created} created`)

    const [link] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from association
       where workspace_id = ${datasaur.id}
         and ((from_id = ${deal.id} and to_id = ${contact.id})
           or (from_id = ${contact.id} and to_id = ${deal.id}))`)
    expect(Number(link?.n) === 1, `${link?.n} association rows`)
    return 'the link a record export cannot carry'
  })

  await check('and importing the same associations twice writes one row', async () => {
    const summary = await importFile('associations', [
      { 'Deal name': `Verify assoc deal ${stamp}`, 'Contact email': `assoc-${stamp}@example.test`, 'Association label': 'Decision maker' },
    ])
    expect(summary.created === 0 && summary.skipped === 1, `${summary.created} created, ${summary.skipped} skipped`)
    return 'the pair is the key, in one stable direction'
  })

  await check('a deal that is not here yet is reported, not invented', async () => {
    const summary = await importFile('associations', [
      { 'Deal name': `Nothing called this ${stamp}`, 'Contact email': `assoc-${stamp}@example.test`, 'Association label': '' },
    ])
    expect(summary.errored === 1, `${summary.errored} errored`)
    expect(
      summary.errors[0]!.reason.includes('Import the deals first'),
      summary.errors[0]!.reason,
    )
    return 'no empty deal is created to hold an orphaned link'
  })

  let importedSegmentId = ''

  await check('a list export becomes a segment holding the people it named', async () => {
    await createRecord(admin, 'contact', { email: `list-a-${stamp}@example.test`, first_name: 'List' })
    await createRecord(admin, 'contact', { email: `list-b-${stamp}@example.test`, first_name: 'List' })
    const summary = await importFile('lists', [
      { 'List name': `Verify list ${stamp}`, 'Email': `list-a-${stamp}@example.test` },
      { 'List name': `Verify list ${stamp}`, 'Email': `list-b-${stamp}@example.test` },
    ])
    expect(summary.errored === 0, summary.errors.map((row) => row.reason).join(' | '))
    expect(summary.created === 2, `${summary.created} created`)

    const rows = await listSegments(admin, 'contact')
    const made = rows.find((row) => row.name === `Verify list ${stamp}`)
    expect(Boolean(made), 'the segment is not there')
    importedSegmentId = made!.id
    expect(made!.isStatic, 'the imported list is not marked static')
    expect(made!.memberCount === 2, `${made!.memberCount} members`)
    return `${made!.memberCount} members, and the list says it is a snapshot`
  })

  await check('and the hourly evaluation leaves an imported list alone', async () => {
    // The bug this exists to stop: the evaluator rebuilds a segment from its
    // query, an imported list carries none, so the first run after a migration
    // would empty all hundred and twenty-nine of them.
    const result = await evaluateSegment(admin, importedSegmentId)
    expect(result.exited === 0, `${result.exited} people were dropped`)
    expect(result.members === 2, `${result.members} members left`)
    return 'a snapshot is not recomputed into nothing'
  })

  await check('form submissions arrive with the form they were sent to', async () => {
    const summary = await importFile('submissions', [
      {
        'Form name': `Verify form ${stamp}`,
        'Email': `list-a-${stamp}@example.test`,
        'Submitted at': '2026-03-04T10:00:00Z',
        'Page URL': 'https://datasaur.ai/pricing',
        'Record ID': `sub-${stamp}-1`,
      },
    ])
    expect(summary.errored === 0, summary.errors.map((row) => row.reason).join(' | '))
    expect(summary.created === 1, `${summary.created} created`)

    const [row] = await db.execute<{ is_active: boolean; n: number }>(sql`
      select f.is_active, count(s.id)::int as n
        from form f left join form_submission s on s.form_id = f.id
       where f.workspace_id = ${datasaur.id} and f.name = ${`Verify form ${stamp}`}
       group by f.is_active`)
    expect(Boolean(row), 'no form was created to hold the history')
    expect(row!.is_active === false, 'the shell form is live, and it has no fields')
    expect(Number(row!.n) === 1, `${row!.n} submissions`)
    return 'an inactive shell, because a HubSpot form does not export as a definition'
  })

  await check('and a second run of the same submission file adds nothing', async () => {
    const summary = await importFile('submissions', [
      {
        'Form name': `Verify form ${stamp}`,
        'Email': `list-a-${stamp}@example.test`,
        'Submitted at': '2026-03-04T10:00:00Z',
        'Page URL': 'https://datasaur.ai/pricing',
        'Record ID': `sub-${stamp}-1`,
      },
    ])
    expect(summary.created === 0 && summary.skipped === 1, `${summary.created} created`)
    return 'the export id is the key, so a redelivery is a no-op'
  })

  await check('an owner nobody here matches leaves the row unassigned and names them once', async () => {
    const run = await createImportRun(admin, {
      objectKey: 'contact',
      kind: 'records',
      source: 'hubspot',
      filename: `verify-owner-${stamp}.csv`,
      headers: ['Email', 'First Name', 'Contact owner'],
      rows: [
        { Email: `owner-a-${stamp}@example.test`, 'First Name': 'Owner', 'Contact owner': `Departed Person ${stamp}` },
        { Email: `owner-b-${stamp}@example.test`, 'First Name': 'Owner', 'Contact owner': `Departed Person ${stamp}` },
      ],
      mapping: {},
    })
    await setImportMapping(admin, run.id, run.suggested)
    for (;;) {
      const progress = await runImportChunk(admin, run.id)
      if (progress.done) break
    }
    const summary = await readImportRun(admin, run.id)
    // Before this, an owner who had left produced one failed row per line, which
    // at eighty-eight thousand rows is a failed import rather than a report.
    expect(summary!.created === 2, `${summary!.created} created, ${summary!.errored} errored`)
    expect(summary!.unmatchedOwners.length === 1, summary!.unmatchedOwners.join(', '))
    expect(summary!.unmatchedOwners[0] === `Departed Person ${stamp}`, summary!.unmatchedOwners.join(', '))
    return 'two records in, one name to act on'
  })

  await check('a stage that does not exist is still a refusal', async () => {
    const run = await createImportRun(admin, {
      objectKey: 'deal',
      kind: 'records',
      source: 'hubspot',
      filename: `verify-stage-${stamp}.csv`,
      headers: ['Deal Name', 'Deal Stage'],
      rows: [{ 'Deal Name': `Verify bad stage ${stamp}`, 'Deal Stage': `Nothing called this ${stamp}` }],
      mapping: {},
    })
    await setImportMapping(admin, run.id, run.suggested)
    for (;;) {
      const progress = await runImportChunk(admin, run.id)
      if (progress.done) break
    }
    const summary = await readImportRun(admin, run.id)
    expect(summary!.errored === 1, `${summary!.errored} errored`)
    // An owner is a person who may not have an account; a stage is a column that
    // is mapped wrong. Only one of those is worth importing around.
    expect(summary!.errors[0]!.reason.includes('deal stage'), summary!.errors[0]!.reason)
    return 'leniency is for owners only, because only owners are people'
  })

  await check('a properties file with no Applies to column is refused at mapping', async () =>
    refuses('a property file that does not say which object', async () => {
      const run = await createImportRun(admin, {
        objectKey: 'contact',
        kind: 'properties',
        source: 'hubspot',
        filename: `verify-bad-props-${stamp}.csv`,
        headers: ['Name'],
        rows: [{ Name: 'Orphan' }],
        mapping: {},
      })
      await setImportMapping(admin, run.id, { Name: 'label' })
    }),
  )

  console.log('')
  console.log('-- Gmail, read only --------------------------------------------')

  const internalDomain = await internalDomainOf(sales)
  let mailboxId = ''

  const incoming = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
    providerThreadId: `t-${stamp}`,
    providerMessageId: `m-${stamp}`,
    subject: 'Verify thread',
    from: 'someone@partner1.example',
    to: [salesUser.email],
    cc: [],
    sentAt: new Date(),
    snippet: 'A snippet.',
    internetMessageId: `<m-${stamp}@partner1.example>`,
    body: { text: 'A body stored at ingest.' },
    hasAttachments: false,
    ...over,
  })

  await check('which domain counts as internal is per workspace', async () => {
    const mine = await internalDomainOf(sales)
    const theirs = await internalDomainOf(probeCtx)
    expect(mine === 'datasaur.ai', `this workspace was told its domain is ${mine}`)
    expect(theirs === 'probe.example', `the other workspace was told its domain is ${theirs}`)
    expect(mine !== theirs, 'both workspaces were handed the same domain')
    // Read through the workspace's organisation, never from a process-wide
    // setting: one process serves every tenant, and the wrong domain inverts
    // every internal/external decision the ingest makes.
    return `${mine} for one, ${theirs} for the other`
  })

  await check('a mailbox stores its tokens encrypted', async () => {
    const saved = await saveMailbox(sales, {
      userId: salesUser.id,
      email: salesUser.email,
      accessToken: `access-${stamp}`,
      refreshToken: `refresh-${stamp}`,
      accessTokenExpiresAt: null,
    })
    mailboxId = saved.id
    const [raw] = await db.execute<{ access_token: string }>(
      sql`select access_token from mailbox where id = ${mailboxId}`,
    )
    expect(!raw!.access_token.includes(stamp), 'the access token is in the database in plain text')
    const read = await readMailbox(sales, mailboxId)
    expect(read?.accessToken === `access-${stamp}`, 'the token did not round-trip')
    return 'a database dump is not a set of live Google credentials'
  })

  await check('an internal-only thread is never stored', async () => {
    const skip = shouldSkip(
      incoming({ from: `colleague@${internalDomain}`, to: [salesUser.email] }),
      { internalDomain, blocked: new Set() },
    )
    expect(Boolean(skip), 'a colleague-to-colleague thread would have been stored')
    return skip ?? ''
  })

  await check('nor one with a personal mail address on it', async () => {
    const skip = shouldSkip(incoming({ from: 'someone@gmail.com' }), {
      internalDomain,
      blocked: new Set(),
    })
    expect(Boolean(skip), 'private mail would have landed in the CRM')
    return skip ?? ''
  })

  await check('an exclusion is applied at ingest, not at display', async () => {
    const entry = await addBlocklistEntry(sales, { pattern: 'agency.example', scope: 'mine' })
    const blocked = await blockedPatterns(sales, salesUser.id)
    const skip = shouldSkip(incoming({ from: 'recruiter@agency.example' }), { internalDomain, blocked })
    expect(Boolean(skip), 'a blocklisted domain was stored anyway')

    const result = await ingestMessage(sales, {
      incoming: incoming({ from: 'recruiter@agency.example' }),
      ownerEmail: salesUser.email,
      mailboxId,
      internalDomain,
      blocked,
    })
    expect(!result.stored, 'the blocked message reached the database')
    await removeBlocklistEntry(sales, entry.id)
    return skip ?? ''
  })

  await check('a workspace-wide exclusion is admin only', async () =>
    refuses('a sales user setting a workspace exclusion', () =>
      addBlocklistEntry(sales, { pattern: 'everyone.example', scope: 'workspace' }),
    ),
  )

  let ingestedContactId = ''

  await check('a real thread is stored and linked to the contact', async () => {
    const contact = await createRecord(admin, 'contact', {
      first_name: 'Verify',
      last_name: 'Correspondent',
      email: `verify-mail-${stamp}@partner1.example`,
    })
    ingestedContactId = contact.id

    const result = await ingestMessage(sales, {
      incoming: incoming({ from: `verify-mail-${stamp}@partner1.example` }),
      ownerEmail: salesUser.email,
      mailboxId,
      internalDomain,
      blocked: new Set(),
    })
    expect(result.stored, 'stored' in result ? '' : (result as { reason: string }).reason)
    expect(result.stored && result.contactIds.includes(ingestedContactId), 'the thread did not reach the contact')

    const threads = await threadsForContact(admin, ingestedContactId)
    expect(threads.length === 1, `${threads.length} threads`)
    return `${threads[0]!.subject} with ${threads[0]!.messageCount} message`
  })

  await check('and it is on the timeline as email', async () => {
    const timeline = await readTimeline(admin, {
      entity: { entityType: 'contact', entityId: ingestedContactId },
      types: ['email'],
    })
    expect(timeline.rows.length >= 1, 'no email activity was written')
    return timeline.rows[0]!.subject ?? ''
  })

  await check('reading the same message again writes nothing twice', async () => {
    const result = await ingestMessage(sales, {
      incoming: incoming({ from: `verify-mail-${stamp}@partner1.example` }),
      ownerEmail: salesUser.email,
      mailboxId,
      internalDomain,
      blocked: new Set(),
    })
    expect(result.stored && !result.created, 'the message was stored a second time')
    const threads = await threadsForContact(admin, ingestedContactId)
    expect(threads[0]!.messageCount === 1, `the thread now claims ${threads[0]!.messageCount} messages`)
    return 'an interrupted back-fill resumes with no duplicates'
  })

  await check('two mailboxes on one thread store it once', async () => {
    const before = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from message_thread where provider_thread_id = ${`t-${stamp}`}`,
    )
    await ingestMessage(admin, {
      incoming: incoming({ providerMessageId: `m2-${stamp}`, from: `verify-mail-${stamp}@partner1.example` }),
      ownerEmail: 'admin@datasaur.ai',
      mailboxId,
      internalDomain,
      blocked: new Set(),
    })
    const after = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from message_thread where provider_thread_id = ${`t-${stamp}`}`,
    )
    expect(Number(before[0]?.n) === Number(after[0]?.n), 'a second mailbox created a second thread')
    return 'one message_thread per provider thread per workspace'
  })

  await check('direction is inferred from who sent it', async () => {
    const [row] = await db.execute<{ direction: string }>(
      sql`select direction from message where provider_message_id = ${`m-${stamp}`}`,
    )
    expect(row?.direction === 'inbound', `direction is ${row?.direction}`)
    return 'inbound, because the owner is not the sender'
  })

  await check('a new person at a known company becomes a contact', async () => {
    const result = await ingestMessage(sales, {
      incoming: incoming({
        providerMessageId: `m3-${stamp}`,
        providerThreadId: `t3-${stamp}`,
        from: `brand-new-${stamp}@partner1.example`,
      }),
      ownerEmail: salesUser.email,
      mailboxId,
      internalDomain,
      blocked: new Set(),
    })
    expect(result.stored && result.contactIds.length > 0, 'nobody was matched or created')
    const [created] = await db.execute<{ email: string; company_id: string | null }>(
      sql`select email, company_id from contact where email = ${`brand-new-${stamp}@partner1.example`}`,
    )
    expect(Boolean(created), 'the new participant was not created')
    expect(created?.company_id !== null, 'the new contact was not filed under the company')
    return 'created under the company its domain implies, owner unassigned'
  })

  await check('a stranger at an unknown domain creates nothing', async () => {
    const before = await db.execute<{ n: number }>(sql`select count(*)::int as n from contact`)
    await ingestMessage(sales, {
      incoming: incoming({
        providerMessageId: `m4-${stamp}`,
        providerThreadId: `t4-${stamp}`,
        from: `nobody-${stamp}@totally-unknown-${stamp}.example`,
        to: [salesUser.email, `verify-mail-${stamp}@partner1.example`],
      }),
      ownerEmail: salesUser.email,
      mailboxId,
      internalDomain,
      blocked: new Set(),
    })
    const after = await db.execute<{ n: number }>(sql`select count(*)::int as n from contact`)
    expect(Number(before[0]?.n) === Number(after[0]?.n), 'a stranger at an unknown domain became a contact')
    return 'the address is kept on the message and linked to nobody'
  })

  await check('revocation stops the sync and says why', async () => {
    await updateMailboxCursor(sales, mailboxId, { state: 'revoked' })
    const rows = await listMailboxes(admin)
    const found = rows.find((row) => row.id === mailboxId)
    expect(found?.state === 'revoked', `state is ${found?.state}`)
    return 'no infinite retry against a decision somebody made'
  })

  await check('disconnecting keeps the history already read', async () => {
    await disconnectMailbox(sales, mailboxId)
    const threads = await threadsForContact(admin, ingestedContactId)
    expect(threads.length >= 1, 'disconnecting erased the correspondence')
    return '"stop reading new mail", not "forget what you read"'
  })

  await check('somebody else’s mailbox cannot be disconnected', async () => {
    const saved = await saveMailbox(sales, {
      userId: salesUser.id,
      email: salesUser.email,
      accessToken: 'a',
      refreshToken: 'b',
      accessTokenExpiresAt: null,
    })
    const message = await refuses('a marketing user disconnecting somebody else’s mailbox', () =>
      disconnectMailbox(ctxFor('marketing'), saved.id),
    )
    await disconnectMailbox(admin, saved.id)
    return message
  })

  console.log('')
  console.log('-- failures and replay -----------------------------------------')

  await check('a dead letter can be claimed for replay exactly once', async () => {
    await recordDeadLetter(admin, {
      jobName: 'verify.job',
      payload: { verify: stamp },
      error: 'Verify failure.',
      attempts: 3,
    })
    const [row] = await db.execute<{ id: string }>(
      sql`select id from dead_letter where job_name = 'verify.job' and payload ->> 'verify' = ${stamp}`,
    )
    const claimed = await claimForReplay(admin, row!.id)
    expect(claimed.jobName === 'verify.job', 'the job name was lost')
    const second = await refuses('claiming the same failure twice', () => claimForReplay(admin, row!.id))
    return second
  })

  await check('a non-admin cannot replay', async () => {
    await recordDeadLetter(admin, {
      jobName: 'verify.job',
      payload: { verify: `${stamp}-2` },
      error: 'Verify failure.',
      attempts: 3,
    })
    const [row] = await db.execute<{ id: string }>(
      sql`select id from dead_letter where payload ->> 'verify' = ${`${stamp}-2`}`,
    )
    return await refuses('a sales user replaying', () => claimForReplay(sales, row!.id))
  })

  console.log('')
  console.log('-- tenancy -----------------------------------------------------')

  await check('one tenant cannot read another’s credentials', async () => {
    const theirs = await readCredentials(probeCtx, 'brevo')
    expect(theirs === null, 'a credential leaked across tenants')
    return 'row level security covers integration'
  })

  await check('nor its unmatched events, mailboxes or suggestions', async () => {
    const events = await listUnmatchedEvents(probeCtx)
    const boxes = await listMailboxes(probeCtx)
    const suggestions = await listSuggestions(probeCtx)
    expect(events.length === 0, `${events.length} events leaked`)
    expect(boxes.length === 0, `${boxes.length} mailboxes leaked`)
    expect(suggestions.length === 0, `${suggestions.length} suggestions leaked`)
    return 'zero rows, not somebody else’s rows'
  })

  // ------------------------------------------- B12: outgoing webhooks

  console.log('')
  console.log('-- what Rawr tells somebody else --------------------------------')

  let endpointId = ''

  // Both of the next two rules only apply in production, because the first
  // receiver anybody writes runs on their own laptop over http. So they are
  // asserted with NODE_ENV set to what production sets it to, and put back.
  const inProduction = async <T>(fn: () => Promise<T>): Promise<T> => {
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      return await fn()
    } finally {
      if (before === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = before
    }
  }

  await check('an endpoint has to be https in production', async () =>
    inProduction(() =>
      refuses('a record sent in plaintext', () =>
        createWebhookEndpoint(admin, { name: 'Plain', url: 'http://example.com/hook', events: [] }),
      ),
    ),
  )

  await check('an endpoint on a private network is refused in production', async () =>
    inProduction(async () => {
      // Otherwise "add a webhook" is a request forgery any admin can aim at
      // whatever else runs on the network Rawr itself is on — the cloud metadata
      // service above all.
      const said = await refuses('an endpoint pointing back inside', () =>
        createWebhookEndpoint(admin, { name: 'Inside', url: 'https://169.254.169.254/latest/meta-data', events: [] }),
      )
      expect(said.includes('private network'), said)
      return said
    }),
  )

  await check('a laptop receiver is allowed outside production', async () => {
    const made = await createWebhookEndpoint(admin, {
      name: `Verify local ${stamp}`,
      url: 'http://127.0.0.1:4599/hook',
      events: [],
    })
    await removeWebhookEndpoint(admin, made.id)
    return 'a webhook nobody can develop against is a webhook nobody uses'
  })

  await check('an event nothing sends is refused at save', async () =>
    refuses('a subscription to something that never fires', () =>
      createWebhookEndpoint(admin, { name: 'Ghost', url: 'https://example.com/hook', events: ['contact.exploded'] }),
    ),
  )

  await check('the signing key comes back exactly once', async () => {
    const made = await createWebhookEndpoint(admin, {
      name: `Verify hook ${stamp}`,
      url: 'https://example.com/hooks/rawr',
      events: ['deal.stage_changed'],
    })
    endpointId = made.id
    expect(made.secret.startsWith('whsec_'), made.secret.slice(0, 8))
    const listed = await listWebhookEndpoints(admin)
    const mine = listed.find((row) => row.id === endpointId)
    expect(Boolean(mine), 'the endpoint is not in the list')
    // Nothing on the read path carries it: a key a screen can redisplay is a key
    // in a screenshot.
    expect(!JSON.stringify(mine).includes(made.secret), 'the signing key is readable after creation')
    return 'issued once, and never returned again'
  })

  await check('only the events it asked for reach it', async () => {
    const wanted = await endpointsFor(admin, 'deal.stage_changed')
    expect(wanted.some((row) => row.id === endpointId), 'it did not get the event it subscribed to')
    const other = await endpointsFor(admin, 'contact.created')
    expect(!other.some((row) => row.id === endpointId), 'it got an event it did not ask for')
    return 'one subscription, one event'
  })

  await check('an empty list means every event, including later ones', async () => {
    await updateWebhookEndpoint(admin, endpointId, { events: [] })
    for (const event of ['contact.created', 'deal.stage_changed', 'contact.form_submitted']) {
      const rows = await endpointsFor(admin, event)
      expect(rows.some((row) => row.id === endpointId), `${event} did not reach it`)
    }
    return 'a warehouse subscribes once and stops re-editing a list'
  })

  await check('a switched-off endpoint is sent nothing', async () => {
    await updateWebhookEndpoint(admin, endpointId, { isActive: false })
    const rows = await endpointsFor(admin, 'contact.created')
    expect(!rows.some((row) => row.id === endpointId), 'a switched-off endpoint was still sent an event')
    await updateWebhookEndpoint(admin, endpointId, { isActive: true })
    return 'off means off, without deleting the key'
  })

  await check('rolling the key replaces it, and the old one stops working', async () => {
    const before = (await endpointsFor(admin, 'contact.created')).find((row) => row.id === endpointId)
    const rolled = await rollWebhookSecret(admin, endpointId)
    const after = (await endpointsFor(admin, 'contact.created')).find((row) => row.id === endpointId)
    expect(rolled !== before?.secret, 'the key did not change')
    expect(after?.secret === rolled, 'the new key is not the one being sent with')
    return 'a rolled key is only rolled if the old one is dead'
  })

  await check('the last delivery is what the row leads with', async () => {
    await recordDelivery(admin, endpointId, { ok: false, status: 500, error: 'The endpoint answered 500.' })
    const failing = (await listWebhookEndpoints(admin)).find((row) => row.id === endpointId)
    expect(failing?.lastError !== null, 'a failure left no trace')
    expect(failing?.lastStatus === 500, `${failing?.lastStatus}`)
    await recordDelivery(admin, endpointId, { ok: true, status: 200 })
    const healthy = (await listWebhookEndpoints(admin)).find((row) => row.id === endpointId)
    // A success clears the error: "failing since Tuesday" beside a row that has
    // delivered since is worse than no health at all.
    expect(healthy?.lastError === null, 'a success left the old failure showing')
    expect(healthy?.lastOkAt !== null, 'a success was not recorded')
    return 'a subscriber that quietly stopped receiving is visible'
  })

  await check('only an admin may subscribe anything to this workspace', async () => {
    const said = await refuses('marketing adding an endpoint', () =>
      createWebhookEndpoint(ctxFor('marketing'), { name: 'Nope', url: 'https://example.com/h', events: [] }),
    )
    expect(said.includes('webhook_endpoint'), said)
    return said
  })

  await check('one tenant cannot see another’s endpoints', async () => {
    expect((await listWebhookEndpoints(probeCtx)).length === 0, 'an endpoint leaked across tenants')
    return 'row level security covers webhook_endpoint'
  })

  await removeWebhookEndpoint(admin, endpointId)

  // Leave the workspace as it was found: the seeded Brevo row was created here.
  await disconnectIntegration(admin, 'brevo')

  console.log('')
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log('all integration and Gmail checks passed.')
  }
} finally {
  await owner.end()
  await closeAppPool()
}
