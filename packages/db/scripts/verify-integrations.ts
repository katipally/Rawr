import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import type { Role, WorkspaceContext } from '../src/dal/context.ts'
import {
  claimForReplay,
  claimInbound,
  disconnectIntegration,
  listIntegrations,
  listUnmatchedEvents,
  once,
  readCredentials,
  recordHealth,
  rematchInbound,
  saveIntegration,
} from '../src/dal/integrations.ts'
import { acceptSuggestion, applyEnrichment, markSource } from '../src/dal/enrichment.ts'
import { listSuggestions, readFieldSources } from '../src/dal/integrations.ts'
import { ingestMarketingEvent, mailableContacts, setExternalId } from '../src/dal/marketing-events.ts'
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
import { readTimeline } from '../src/dal/activity.ts'
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
    expect(rows.length >= 7, `${rows.length} kinds listed`)
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

  await check('the provider’s own id is kept for the next sync', async () => {
    await setExternalId(admin, trackedId, 'brevo', `brevo-${stamp}`)
    const [row] = await db.execute<{ id: string }>(
      sql`select external_ids ->> 'brevo' as id from contact where id = ${trackedId}`,
    )
    expect(row?.id === `brevo-${stamp}`, 'the external id was not stored')
    return 'the sync is incremental rather than a full re-push'
  })

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
    bodyRef: `gmail:m-${stamp}`,
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
