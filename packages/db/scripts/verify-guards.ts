import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import { promoteFieldToHot } from '../src/dal/fields.ts'
import { replayDeadLetter } from '../src/dal/jobs.ts'
import {
  CRITICAL_ACTIONS,
  ForbiddenError,
  canDo,
  type AccountContext,
  type CriticalAction,
  type Hub,
} from '../src/dal/context.ts'
import { purgeField } from '../src/dal/admin-fields.ts'
import { exportCsv } from '../src/dal/export.ts'
import { beginImportRun, beginImportUpload, setImportMapping, startImportRun } from '../src/dal/imports.ts'
import { deleteView } from '../src/dal/views.ts'
import { deleteSegment, evaluateSegment, saveSegment } from '../src/dal/segments.ts'
import { rematchInbound } from '../src/dal/integrations.ts'
import { formsReport, pipelineReport } from '../src/dal/reporting.ts'
import { listForms } from '../src/dal/forms.ts'
import { listSequences } from '../src/dal/sequences.ts'
import { listSegments, readMemberships } from '../src/dal/segments.ts'
import { listTasks, overdueNextSteps } from '../src/dal/tasks.ts'
import { inboxCounts, listInboxThreads } from '../src/dal/messages.ts'
import { listBookings } from '../src/dal/bookings.ts'
import { listBookingPages } from '../src/dal/booking-admin.ts'
import { readAgenda } from '../src/dal/calendar.ts'
import { listCampaigns } from '../src/dal/campaigns.ts'
import { listEventDefs } from '../src/dal/custom-events.ts'
import { listSites } from '../src/dal/analytics.ts'
import { readDashboard } from '../src/dal/dashboard.ts'
import { listReportDashboards } from '../src/dal/report-dashboards.ts'
import { bulkDeleteRecords, deleteRecord, listRecords, mergeRecords } from '../src/dal/records.ts'
import { setMemberGrants } from '../src/dal/members.ts'
import { withAccount } from '../src/dal/index.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import { SANDBOX, cleanup } from './fixture.ts'

/** Proves the hub matrix and the audit trail by calling the mutation directly,
 *  not by checking that a button is hidden. */

/** The shapes of access worth proving, named for the seat the seed gives them.
 *  `account` is the hub every settings mutation asks for, so the first holds it
 *  and none of the others do. */
const SEATS = {
  admin: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
  sales: ['contacts', 'sales'],
  marketing: ['contacts', 'marketing'],
  viewer: [],
} as const satisfies Record<string, readonly Hub[]>

type Seat = keyof typeof SEATS

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })

const failures: string[] = []
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const contextFor = (accountId: string, userId: string, seat: Seat): AccountContext => ({
  accountId,
  actorId: userId,
  actorKind: 'user',
  isSuperAdmin: false,
  viewHubs: [],
  editHubs: [...SEATS[seat]],
})

/** Set as soon as the account is known, so the cleanup in `finally` can run even
 *  when a check throws before the probes are made. */
let probeAccountId: string | null = null

try {
  const [ws] = await owner`select id from account where slug = ${SANDBOX.slug}`
  if (!ws) throw new Error('Seed the database first: pnpm db:seed')
  const accountId = ws.id as string
  probeAccountId = accountId

  const [actor] = await owner`
    select u.id from user_account u
      join membership m on m.user_id = u.id
     where m.account_id = ${accountId} limit 1`
  const actorId = actor!.id as string

  const [contactObject] = await owner`
    select id from object_def where account_id = ${accountId} and key = 'contact'`

  // One custom jsonb field per seat attempt, so a success does not make the next
  // attempt fail for the wrong reason.
  const fieldIds: Record<Seat, string> = {} as Record<Seat, string>
  for (const role of Object.keys(SEATS) as Seat[]) {
    const key = `guard_probe_${role}`
    await owner`delete from field_def where account_id = ${accountId} and key = ${key}`
    const [created] = await owner`
      insert into field_def (account_id, object_id, key, label, type, storage, is_custom, position)
      values (${accountId}, ${contactObject!.id}, ${key}, ${'Guard probe ' + role},
              'text', 'jsonb', true, 99)
      returning id`
    fieldIds[role] = created!.id as string
  }

  for (const role of Object.keys(SEATS) as Seat[]) {
    const ctx = contextFor(accountId, actorId, role)
    let outcome: 'allowed' | 'forbidden' | 'other' = 'other'
    let message = ''
    try {
      await promoteFieldToHot(ctx, fieldIds[role])
      outcome = 'allowed'
    } catch (cause) {
      if (cause instanceof ForbiddenError) {
        outcome = 'forbidden'
        message = cause.message
      } else {
        message = cause instanceof Error ? cause.message : String(cause)
      }
    }

    if (role === 'admin') {
      check(outcome === 'allowed', 'the account hub can promote a field to hot', message)
    } else {
      check(
        outcome === 'forbidden',
        `${role} is refused when promoting a field`,
        outcome === 'forbidden' ? `message: "${message}"` : `got ${outcome}: ${message}`,
      )
    }
  }

  const [audit] = await owner`
    select actor_id, actor_kind, entity, action, before, after
      from audit_log
     where account_id = ${accountId} and entity = 'field_def' and action = 'promote_to_hot'
     order by at desc limit 1`
  check(audit !== undefined, 'the successful promotion wrote an audit_log row')
  check(audit?.actor_id === actorId, 'the audit row is attributed to the real actor')
  check(
    audit?.before?.isHot === false && audit?.after?.isHot === true,
    'the audit row carries before and after',
    JSON.stringify({ before: audit?.before, after: audit?.after }),
  )

  const [refusedField] = await owner`
    select is_hot from field_def where id = ${fieldIds.viewer}`
  check(refusedField?.is_hot === false, 'a refused promotion changed nothing')

  const [pending] = await owner`
    select fi.state, fi.pg_index_name from field_index fi
      join field_def f on f.id = fi.field_id
     where f.id = ${fieldIds.admin}`
  check(
    pending?.state === 'pending' || pending?.state === 'building' || pending?.state === 'ready',
    'the promotion queued an index build',
    `state: ${pending?.state}, index: ${pending?.pg_index_name}`,
  )

  // A dead letter that can only be replayed by an admin, proven by trying as both.
  const [fi] = await owner`
    select fi.id from field_index fi where fi.field_id = ${fieldIds.admin}`
  const [letter] = await owner`
    insert into dead_letter (account_id, job_name, payload, error, attempts)
    values (${accountId}, 'field-index.create',
            ${owner.json({ accountId, fieldIndexId: fi!.id, objectKey: 'contact', fieldKey: 'guard_probe_admin' })},
            'Simulated failure for the guard check.', 5)
    returning id`

  let viewerReplay = 'other'
  try {
    await replayDeadLetter(contextFor(accountId, actorId, 'viewer'), letter!.id as string)
    viewerReplay = 'allowed'
  } catch (cause) {
    viewerReplay = cause instanceof ForbiddenError ? 'forbidden' : 'other'
  }
  check(viewerReplay === 'forbidden', 'a seat without the account hub cannot replay a failed job')

  await replayDeadLetter(contextFor(accountId, actorId, 'admin'), letter!.id as string)
  const [afterReplay] = await owner`
    select dl.replayed_at, fi.state
      from dead_letter dl join field_index fi on fi.id = ${fi!.id}
     where dl.id = ${letter!.id}`
  check(
    afterReplay?.replayed_at !== null && afterReplay?.state === 'pending',
    'an account-hub replay stamps the dead letter and re-queues the index',
    `state: ${afterReplay?.state}`,
  )

  let secondReplay = 'allowed'
  try {
    await replayDeadLetter(contextFor(accountId, actorId, 'admin'), letter!.id as string)
  } catch {
    secondReplay = 'refused'
  }
  check(secondReplay === 'refused', 'replaying the same failure twice is refused')

  const [auditWritable] = await owner`
    select has_table_privilege('rawr_app', 'audit_log', 'UPDATE') as can_update,
           has_table_privilege('rawr_app', 'audit_log', 'DELETE') as can_delete`
  check(
    auditWritable?.can_update === false && auditWritable?.can_delete === false,
    'the app role has no UPDATE or DELETE grant on audit_log',
  )
  // Ownership on top of the role matrix: the things a role may do in general but
  // not to somebody else's.
  const [other] = await owner`
    select u.id from user_account u join membership m on m.user_id = u.id
     where m.account_id = ${accountId} and u.id <> ${actorId} limit 1`
  const otherId = other!.id as string
  const [view] = await owner`
    insert into saved_view (account_id, object_id, name, slug, kind, owner_id, is_shared, filters, sorts, columns, position)
    values (${accountId}, ${contactObject!.id}, 'Guard probe view', 'guard-probe-view', 'table', ${otherId}, true, '[]', '[]', '["first_name"]', 99)
    returning id`
  const outcomeOf = async (fn: () => Promise<unknown>): Promise<'allowed' | 'refused'> => {
    try {
      await fn()
      return 'allowed'
    } catch {
      return 'refused'
    }
  }
  check(
    (await outcomeOf(() => deleteView(contextFor(accountId, actorId, 'sales'), view!.id as string))) === 'refused',
    "a sales user cannot delete somebody else's view",
  )
  check(
    (await outcomeOf(() => deleteView(contextFor(accountId, actorId, 'admin'), view!.id as string))) === 'allowed',
    'an admin can delete anybody’s view',
  )

  const probeSegment = await saveSegment(contextFor(accountId, actorId, 'admin'), {
    objectKey: 'contact',
    name: 'Guard probe segment',
    filters: [{ conjunction: 'and', conditions: [{ field: 'email', operator: 'is_not_empty' }] }],
  })
  check(
    (await outcomeOf(() => evaluateSegment(contextFor(accountId, actorId, 'viewer'), probeSegment.id))) === 'refused',
    'viewer cannot evaluate a segment',
  )
  check(
    (await outcomeOf(() => evaluateSegment(contextFor(accountId, actorId, 'marketing'), probeSegment.id))) === 'allowed',
    'marketing can evaluate a segment',
  )
  await deleteSegment(contextFor(accountId, actorId, 'admin'), probeSegment.id)
  check(
    (await outcomeOf(() => rematchInbound(contextFor(accountId, actorId, 'sales')))) === 'refused',
    'sales cannot rematch inbound provider events',
  )
  check(
    (await outcomeOf(() => rematchInbound(contextFor(accountId, actorId, 'admin')))) === 'allowed',
    'admin can rematch inbound provider events',
  )

  // ------------------------------------------------------- critical actions
  // HubSpot's Critical column: each act is either irreversible or reaches the
  // whole database, so none of them falls out of holding a hub at edit. Proved by
  // calling each one twice with the same hubs and only the grant differing.
  const criticalCtx = (grants: readonly CriticalAction[]): AccountContext => ({
    accountId,
    actorId,
    actorKind: 'user',
    isSuperAdmin: false,
    viewHubs: [],
    editHubs: [...SEATS.admin],
    criticalGrants: grants,
  })
  const none = criticalCtx([])

  const criticalStamp = Date.now()
  const probeContacts = await owner<{ id: string }[]>`
    insert into contact (account_id, first_name, last_name, email) values
      (${accountId}, 'Critical', 'One', ${`critical.1.${criticalStamp}@guard.test`}),
      (${accountId}, 'Critical', 'Two', ${`critical.2.${criticalStamp}@guard.test`}),
      (${accountId}, 'Critical', 'Three', ${`critical.3.${criticalStamp}@guard.test`}),
      (${accountId}, 'Critical', 'Four', ${`critical.4.${criticalStamp}@guard.test`})
    returning id`

  const forbidden = async (fn: () => Promise<unknown>): Promise<boolean> => {
    try {
      await fn()
      return false
    } catch (cause) {
      return cause instanceof ForbiddenError
    }
  }

  check(
    await forbidden(() => deleteRecord(none, 'contact', probeContacts[0]!.id)),
    'a full set of hubs is refused when deleting a record',
  )
  check(
    (await outcomeOf(() => deleteRecord(criticalCtx(['delete']), 'contact', probeContacts[0]!.id))) === 'allowed',
    'and the delete grant allows it',
  )

  check(
    await forbidden(() =>
      mergeRecords(none, {
        objectKey: 'contact',
        survivorId: probeContacts[1]!.id,
        absorbedId: probeContacts[2]!.id,
        picks: {},
      }),
    ),
    'merging is refused without the merge grant',
  )
  check(
    (await outcomeOf(() =>
      mergeRecords(criticalCtx(['merge']), {
        objectKey: 'contact',
        survivorId: probeContacts[1]!.id,
        absorbedId: probeContacts[2]!.id,
        picks: {},
      }),
    )) === 'allowed',
    'and the merge grant allows it',
  )

  check(
    await forbidden(() => bulkDeleteRecords(none, 'contact', [probeContacts[3]!.id])),
    'a bulk delete is refused without its own grant, even holding delete',
  )
  check(
    await forbidden(() => bulkDeleteRecords(criticalCtx(['delete']), 'contact', [probeContacts[3]!.id])),
    'the single-record delete grant does not carry the bulk one',
  )
  check(
    (await outcomeOf(() => bulkDeleteRecords(criticalCtx(['bulk_delete']), 'contact', [probeContacts[3]!.id]))) ===
      'allowed',
    'and the bulk delete grant allows it',
  )

  // Guarded before the row is looked up, so a missing id proves the order: no
  // grant is a refusal, the grant is the ordinary "it is not there" error.
  const missing = '00000000-0000-0000-0000-000000000000'
  const runInput = { objectKey: 'contact', filename: 'guard.csv', headers: ['Email'] }
  check(await forbidden(() => beginImportRun(none, runInput)), 'uploading a file to import is refused without the import grant')
  check(await forbidden(() => setImportMapping(none, missing, {})), 'and so is mapping it')
  check(
    await forbidden(() => beginImportUpload(none, { objectKey: 'contact', filename: 'guard.csv', sizeBytes: 10 } as never)),
    'and so is a large upload',
  )
  check(await forbidden(() => startImportRun(none, missing)), 'starting an import is refused without the import grant')
  check(
    !(await forbidden(() => startImportRun(criticalCtx(['import']), missing))),
    'and the import grant gets past the guard',
  )
  check(await forbidden(() => purgeField(none, missing)), 'purging a field is refused without the purge grant')
  check(
    !(await forbidden(() => purgeField(criticalCtx(['purge']), missing))),
    'and the purge grant gets past the guard',
  )

  const firstChunk = async (ctx: AccountContext): Promise<string> => {
    for await (const chunk of exportCsv(ctx, {
      objectKey: 'contact',
      columns: ['email'],
      filters: [],
      sorts: [],
    })) {
      return chunk
    }
    return ''
  }
  check(await forbidden(() => firstChunk(none)), 'exporting a view is refused without the export grant')
  check((await firstChunk(criticalCtx(['export']))).startsWith('\uFEFFEmail'), 'and the export grant streams the file')

  check(
    CRITICAL_ACTIONS.every((action) => !canDo(none, action)) &&
      CRITICAL_ACTIONS.every((action) => canDo(criticalCtx(CRITICAL_ACTIONS), action)),
    'an empty grant list holds none of the critical acts, and a full one holds all six',
  )

  await owner`delete from contact where account_id = ${accountId} and email like ${`critical.%.${criticalStamp}@guard.test`}`

  // ---------------------------------------------------------- record scope
  // The third axis, and the only one enforced in the policy rather than in a
  // guard: a seat reaching everything, its team's records, or only its own.
  // Checked by counting through listRecords, because a scope that holds in the
  // data access layer but not in the policy would still leak to the exporter
  // and the agent surface, which do not go through it.
  // Saved whole, because setMemberGrants replaces a grant rather than merging
  // into it: narrowing a seat for this section and walking away would leave the
  // seeded seats stripped, and every later suite would fail on a refusal.
  const seats = await owner<{ id: string; email: string; is_super_admin: boolean; view_hubs: Hub[]; edit_hubs: Hub[] }[]>`
    select u.id, u.email, m.is_super_admin, m.view_hubs, m.edit_hubs
      from membership m join user_account u on u.id = m.user_id
     where m.account_id = ${accountId}`
  const salesSeat = seats.find((row) => row.email === 'sales@sandbox.test')!
  const marketingSeat = seats.find((row) => row.email === 'marketing@sandbox.test')!
  const adminSeat = seats.find((row) => row.email === 'admin@sandbox.test')!
  const superAdmin: AccountContext = {
    accountId, actorId: adminSeat.id, actorKind: 'user',
    isSuperAdmin: true, viewHubs: [], editHubs: [],
  }

  const scopeStamp = Date.now()
  const held = async (userId: string) => {
    const ctx: AccountContext = {
      accountId, actorId: userId, actorKind: 'user',
      isSuperAdmin: false, viewHubs: ['contacts'], editHubs: [],
    }
    return (await listRecords(ctx, { object: 'contact', limit: 1, count: true })).total ?? 0
  }
  const scopeTo = (userId: string, scope: 'everything' | 'team' | 'own') =>
    setMemberGrants(superAdmin, {
      userId, viewHubs: ['contacts'], editHubs: [],
      viewScopes: scope === 'everything' ? {} : { contacts: scope },
    })

  // Two contacts nobody else owns, so the counts do not depend on the seed.
  await owner`insert into contact (account_id, first_name, last_name, email, owner_id) values
    (${accountId}, 'Scope', 'Sales', ${`scope.s.${scopeStamp}@guard.test`}, ${salesSeat.id}),
    (${accountId}, 'Scope', 'Marketing', ${`scope.m.${scopeStamp}@guard.test`}, ${marketingSeat.id})`

  await scopeTo(salesSeat.id, 'everything')
  const everything = await held(salesSeat.id)
  await scopeTo(salesSeat.id, 'own')
  const ownOnly = await held(salesSeat.id)
  check(ownOnly < everything, 'a seat scoped to its own records sees fewer than the whole account',
    `${ownOnly} of ${everything}`)

  const [scopeTeam] = await owner<{ id: string }[]>`
    insert into team (account_id, name) values (${accountId}, ${`Scope probe ${scopeStamp}`}) returning id`
  await owner`insert into team_member (account_id, team_id, user_id) values
    (${accountId}, ${scopeTeam!.id}, ${salesSeat.id}), (${accountId}, ${scopeTeam!.id}, ${marketingSeat.id})`

  await scopeTo(marketingSeat.id, 'own')
  const marketingOwn = await held(marketingSeat.id)
  await scopeTo(marketingSeat.id, 'team')
  const marketingTeam = await held(marketingSeat.id)
  // Every scope sees an unowned record, which is the next check and the whole
  // reason a scoped account does not strand its leads. So it is in both of the
  // "own" counts, and adding them without taking it back out counts it twice:
  // team = sales' own + marketing's own - the unowned they share.
  const [unowned] = await owner<{ n: number }[]>`
    select count(*)::int as n from contact
     where account_id = ${accountId} and owner_id is null and deleted_at is null`
  check(marketingTeam === ownOnly + marketingOwn - unowned!.n,
    "a team scope reaches exactly its team's records and no further",
    `${marketingTeam} = ${ownOnly} + ${marketingOwn} - ${unowned!.n} unowned`)

  // A lead nobody holds must stay reachable, or scoping an account strands every
  // unassigned record in it.
  await owner`insert into contact (account_id, first_name, last_name, email)
    values (${accountId}, 'Scope', 'Unowned', ${`scope.u.${scopeStamp}@guard.test`})`
  check(await held(salesSeat.id) === ownOnly + 1, 'an unassigned record is visible at every scope')

  // What hangs off a record is judged by the record: the sales seat is scoped to
  // its own contacts, so everything said about the marketing seat's contact is
  // out of its reach, and everything about its own is in.
  const hung = `hung-${scopeStamp}`
  const [mine, theirs] = await Promise.all(
    [`scope.s.${scopeStamp}@guard.test`, `scope.m.${scopeStamp}@guard.test`].map(
      async (email) => (await owner<{ id: string }[]>`select id from contact where account_id = ${accountId} and email = ${email}`)[0]!.id,
    ),
  )
  const [hungSegment] = await owner<{ id: string }[]>`
    insert into segment (account_id, name, object_id, query)
    values (${accountId}, ${hung}, ${contactObject!.id}, '{}'::jsonb) returning id`
  const [hungThread] = await owner<{ id: string }[]>`
    insert into message_thread (account_id, provider_thread_id, subject)
    values (${accountId}, ${hung}, ${hung}) returning id`
  for (const [entityId, who] of [[mine!, 'mine'], [theirs!, 'theirs']] as const) {
    const [note] = await owner<{ id: string }[]>`
      insert into activity (account_id, type, subject, occurred_at, actor_kind, actor_id)
      values (${accountId}, 'note', ${`${hung} ${who}`}, now(), 'user', ${marketingSeat.id}) returning id`
    await owner`insert into activity_link (account_id, activity_id, entity_type, entity_id, type, occurred_at)
      values (${accountId}, ${note!.id}, 'contact', ${entityId}, 'note', now())`
    await owner`insert into task (account_id, title, entity_type, entity_id, assignee_id)
      values (${accountId}, ${`${hung} ${who}`}, 'contact', ${entityId}, ${marketingSeat.id})`
    await owner`insert into attachment (account_id, entity_type, entity_id, storage_key, filename, bytes, mime)
      values (${accountId}, 'contact', ${entityId}, ${`${hung}/${who}`}, ${`${hung} ${who}`}, 1, 'text/plain')`
    await owner`insert into segment_membership (account_id, segment_id, entity_id)
      values (${accountId}, ${hungSegment!.id}, ${entityId})`
    await owner`insert into notification (account_id, user_id, kind, dedupe_key, title, entity, entity_id)
      values (${accountId}, ${salesSeat.id}, 'task_assigned', ${`${hung}:${who}`}, ${`${hung} ${who}`}, 'contact', ${entityId})`
    const [mail] = await owner<{ id: string }[]>`
      insert into message (account_id, thread_id, provider_message_id, direction, sent_at, snippet)
      values (${accountId}, ${hungThread!.id}, ${`${hung}-${who}`}, 'inbound', now(), ${`${hung} ${who}`}) returning id`
    await owner`insert into message_participant (account_id, message_id, address, contact_id, role)
      values (${accountId}, ${mail!.id}, ${`${who}.${hung}@guard.test`}, ${entityId}, 'from')`
  }
  await owner`insert into association (account_id, from_type, from_id, to_type, to_id)
    values (${accountId}, 'contact', ${mine!}, 'contact', ${theirs!})`
  await owner`insert into task (account_id, title, entity_type, entity_id, assignee_id)
    values (${accountId}, ${`${hung} assigned`}, 'contact', ${theirs!}, ${salesSeat.id})`
  await owner`insert into task (account_id, title) values (${accountId}, ${`${hung} standalone`})`

  const sees = async (ctx: AccountContext, table: string, column: string) =>
    withAccount(ctx, async (tx) =>
      (await tx.execute(sql`select ${sql.raw(column)} as v from ${sql.raw(table)} where ${sql.raw(column)}::text like ${`%${hung}%`} order by 1`))
        .map((row) => String(row.v).replace(/.*hung-\d+[ .:\-/]?/, '')),
    )
  const narrowed: AccountContext = { accountId, actorId: salesSeat.id, actorKind: 'user', isSuperAdmin: false, viewHubs: ['contacts'], editHubs: [] }
  const reads = (await Promise.all([
    sees(narrowed, 'activity', 'subject'),
    sees(narrowed, 'task', 'title'),
    sees(narrowed, 'attachment', 'filename'),
    sees(narrowed, 'notification', 'title'),
    sees(narrowed, 'message', 'snippet'),
  ])) as string[][]
  const labels = ['timeline entries', 'tasks', 'files', 'notices', 'mail']
  reads.forEach((got, i) => {
    const expected = labels[i] === 'tasks' ? ['assigned', 'mine', 'standalone'] : ['mine']
    check(JSON.stringify(got) === JSON.stringify(expected),
      `a seat scoped to its own records reads the ${labels[i]} of its own and no colleague's`, got.join(', '))
  })
  const memberOf = await withAccount(narrowed, (tx) => tx.execute(sql`select entity_id from segment_membership where segment_id = ${hungSegment!.id}`))
  check(memberOf.length === 1 && memberOf[0]!.entity_id === mine, 'and a list shows it only its own members', `${memberOf.length}`)
  const linked = await withAccount(narrowed, (tx) => tx.execute(sql`select 1 from association where to_id = ${theirs!} or from_id = ${theirs!}`))
  check(linked.length === 0, 'and no association that ends at a record it cannot open')
  const wholeThread = await withAccount(narrowed, (tx) => tx.execute(sql`select 1 from message_thread where id = ${hungThread!.id}`))
  check(wholeThread.length === 1, 'while a thread it can read through its own contact stays')
  const wide = await withAccount(superAdmin, (tx) => tx.execute(sql`select 1 from activity where subject like ${`${hung}%`}`))
  check(wide.length === 2, 'a super admin reads them all', `${wide.length}`)

  await owner`delete from activity where subject like ${`${hung}%`}`
  await owner`delete from task where title like ${`${hung}%`}`
  await owner`delete from attachment where storage_key like ${`${hung}/%`}`
  await owner`delete from notification where dedupe_key like ${`${hung}:%`}`
  await owner`delete from association where from_id = ${mine!} and to_id = ${theirs!}`
  await owner`delete from segment where id = ${hungSegment!.id}`
  await owner`delete from message_thread where id = ${hungThread!.id}`

  // ------------------------------------------------------------ view hubs
  // A hub nobody granted is not readable, not merely not linked to. The record
  // tables are refused by the policy (so the exporter and an agent meet it too),
  // the screens by the layer.
  const dealsHeld = async (userId: string, hubs: Hub[]) => {
    const ctx: AccountContext = {
      accountId, actorId: userId, actorKind: 'user', isSuperAdmin: false, viewHubs: hubs, editHubs: [],
    }
    return (await listRecords(ctx, { object: 'deal', limit: 1, count: true })).total ?? 0
  }
  await setMemberGrants(superAdmin, { userId: salesSeat.id, viewHubs: ['contacts', 'sales'], editHubs: [] })
  const dealsWithHub = await dealsHeld(salesSeat.id, ['contacts', 'sales'])
  await setMemberGrants(superAdmin, { userId: salesSeat.id, viewHubs: ['contacts'], editHubs: [] })
  check(dealsWithHub > 0 && (await dealsHeld(salesSeat.id, ['contacts'])) === 0,
    'a seat without the sales hub reads no deals, however it asks', `${dealsWithHub} with the hub`)
  await setMemberGrants(superAdmin, { userId: salesSeat.id, viewHubs: [], editHubs: [] })
  check((await held(salesSeat.id)) === 0, 'a seat with no hubs reads no contacts')
  await setMemberGrants(superAdmin, { userId: salesSeat.id, viewHubs: [], editHubs: ['contacts'] })
  check((await held(salesSeat.id)) > 0, 'an edit grant reads what a view grant would')

  // A hard DELETE is judged by the edit scope, like an UPDATE. The app only ever
  // soft deletes, so this is the policy holding where the code does not look.
  await setMemberGrants(superAdmin, {
    userId: salesSeat.id, viewHubs: ['contacts'], editHubs: ['contacts'], editScopes: { contacts: 'own' },
  })
  const deleter: AccountContext = {
    accountId, actorId: salesSeat.id, actorKind: 'user', isSuperAdmin: false, viewHubs: ['contacts'], editHubs: ['contacts'],
  }
  const hardDelete = (email: string) =>
    withAccount(deleter, (tx) => tx.execute(sql`delete from contact where email = ${email} returning id`)).then((rows) => rows.length)
  check((await hardDelete(`scope.m.${scopeStamp}@guard.test`)) === 0, 'a seat scoped to edit its own records cannot hard delete a colleague’s')
  check((await hardDelete(`scope.s.${scopeStamp}@guard.test`)) === 1, 'and can hard delete its own')

  const [outsider] = await owner<{ id: string }[]>`
    select u.id from user_account u
     where not exists (select 1 from membership m where m.user_id = u.id and m.account_id = ${accountId}) limit 1`
  if (outsider) {
    check((await held(outsider.id)) === 0, 'a user with no seat in the account reads nothing in it')
  }

  const screenCtx = (seat: Seat, view: Hub[] = []): AccountContext => ({
    accountId, actorId, actorKind: 'user', isSuperAdmin: false, viewHubs: view, editHubs: [...SEATS[seat]],
  })
  const range = { from: new Date(Date.now() - 7 * 864e5), to: new Date() }
  const screens: [string, (ctx: AccountContext) => Promise<unknown>, Hub][] = [
    ['the pipeline report', (c) => pipelineReport(c, range), 'reports'],
    ['the forms report', (c) => formsReport(c, range), 'reports'],
    ['report dashboards', (c) => listReportDashboards(c), 'reports'],
    ['the form list', (c) => listForms(c), 'marketing'],
    ['the sequence list', (c) => listSequences(c), 'sales'],
    ['the segment list', (c) => listSegments(c), 'contacts'],
    ['a record\u2019s segment memberships', (c) => readMemberships(c, crypto.randomUUID()), 'contacts'],
    ['the task list', (c) => listTasks(c), 'contacts'],
    ['the overdue next steps', (c) => overdueNextSteps(c), 'sales'],
    ['the inbox', (c) => listInboxThreads(c, {}), 'contacts'],
    ['the inbox counts', (c) => inboxCounts(c), 'contacts'],
    ['the bookings list', (c) => listBookings(c), 'sales'],
    ['the booking pages', (c) => listBookingPages(c), 'sales'],
    ['the meetings calendar', (c) => readAgenda(c, { month: new Date().toISOString().slice(0, 7) }), 'sales'],
    ['the campaign list', (c) => listCampaigns(c), 'marketing'],
    ['the event list', (c) => listEventDefs(c), 'marketing'],
    ['the site list', (c) => listSites(c), 'marketing'],
  ]
  for (const [label, read, hub] of screens) {
    check(await forbidden(() => read(screenCtx('viewer'))), `${label} is refused to a seat with no hubs`)
    check(!(await forbidden(() => read(screenCtx('viewer', [hub])))), `and read with only the ${hub} view grant`)
  }

  const blank = await readDashboard(screenCtx('viewer'))
  check(
    blank.stages.length === 0 && blank.closingThisMonth.length === 0 && blank.upcoming.length === 0 &&
      blank.newContacts === 0 && blank.quarantined === 0 && blank.myOpenTasks === 0,
    'the home dashboard carries no card for a hub the seat does not hold',
  )
  check((await readDashboard(screenCtx('admin'))).stages.length > 0, 'and every card for a seat that holds them')

  for (const seat of [salesSeat, marketingSeat]) {
    await setMemberGrants(superAdmin, {
      userId: seat.id,
      isSuperAdmin: seat.is_super_admin,
      viewHubs: seat.view_hubs,
      editHubs: seat.edit_hubs,
    })
  }
  await owner`delete from team where id = ${scopeTeam!.id}`
  await owner`delete from contact where account_id = ${accountId} and email like ${`scope.%.${scopeStamp}@guard.test`}`

} finally {
  // The probes are artefacts of this script, so it takes them with it -- from
  // here, not from the end of the checks. A failing check used to skip this and
  // leave four properties named "Guard probe ..." in a real account's contact
  // editor, where nobody could tell they were not somebody's own field.
  if (probeAccountId) {
    const at = probeAccountId
    await owner`delete from saved_view where account_id = ${at} and slug = 'guard-probe-view'`
    await owner`delete from dead_letter where account_id = ${at} and error like 'Simulated failure%'`
    await owner`delete from field_def where account_id = ${at} and key like 'guard_probe_%'`
    await owner.unsafe('drop index if exists hot_contact_guard_probe_admin')
  }

  // The mutations under test query through the app pool, so this script owns two
  // connections to give back, not one. Leaving the second open is what made
  // `pnpm verify` hang here on an unsettled top-level await.
  await Promise.all([owner.end(), closeAppPool()])
  await cleanup()
}

if (failures.length) {
  console.error(`\n${failures.length} guard check(s) failed.`)
  process.exit(1)
}
console.log('\nall guard checks passed.')
