import postgres from 'postgres'
import { promoteFieldToHot } from '../src/dal/fields.ts'
import { replayDeadLetter } from '../src/dal/jobs.ts'
import { ForbiddenError, type AccountContext, type Hub } from '../src/dal/context.ts'
import { deleteView } from '../src/dal/views.ts'
import { deleteSegment, evaluateSegment, saveSegment } from '../src/dal/segments.ts'
import { rematchInbound } from '../src/dal/integrations.ts'
import { closeAppPool } from '../src/internal/pool.ts'

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

try {
  const [ws] = await owner`select id from account where slug = 'datasaur'`
  if (!ws) throw new Error('Seed the database first: pnpm db:seed')
  const accountId = ws.id as string

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

  // The probes are artefacts of this script, so it takes them with it.
  await owner`delete from saved_view where account_id = ${accountId} and slug = 'guard-probe-view'`
  await owner`delete from dead_letter where account_id = ${accountId} and error like 'Simulated failure%'`
  await owner`delete from field_def where account_id = ${accountId} and key like 'guard_probe_%'`
  await owner.unsafe('drop index if exists hot_contact_guard_probe_admin')
} finally {
  // The mutations under test query through the app pool, so this script owns two
  // connections to give back, not one. Leaving the second open is what made
  // `pnpm verify` hang here on an unsettled top-level await.
  await Promise.all([owner.end(), closeAppPool()])
}

if (failures.length) {
  console.error(`\n${failures.length} guard check(s) failed.`)
  process.exit(1)
}
console.log('\nall guard checks passed.')
