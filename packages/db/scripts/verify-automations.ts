import { drizzle } from 'drizzle-orm/postgres-js'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import type { AccountContext } from '../src/dal/context.ts'
import {
  armedScans,
  claimAutomationRun,
  finishAutomationRun,
  listAutomationRuns,
  openScannedRun,
  parkAutomationRun,
  removeAutomation,
  saveAutomation,
  scanTargets,
  setAutomationActive,
} from '../src/dal/automations.ts'
import { createRecord } from '../src/dal/records.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import { SANDBOX, PEER, cleanup, seatFor } from './fixture.ts'

/** P1 items 5 to 8: the two triggers nothing announces, the three actions that
 *  reach outside the record, if/then branches, and the run log behind them.
 *
 *  Everything here needs migrations 0067 (the two enum values) and 0068
 *  (`step_path`, `scan_day` and its unique index). Until the migrator has run,
 *  every check in this file fails at the first write, which is the correct
 *  reading of "the column is not there yet". */

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
    pass(what, (await fn()) ?? '')
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
const dayUtc = (offsetDays: number): string =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10)

const made: string[] = []
/** Held outside the try so the cleanup below can reach it whatever failed. */
let adminCtx: AccountContext | null = null

try {
  const [sandbox] = await db.select().from(s.account).where(eq(s.account.slug, SANDBOX.slug))
  const [peer] = await db.select().from(s.account).where(eq(s.account.slug, PEER.slug))
  if (!sandbox || !peer) throw new Error('Run pnpm db:seed first.')

  const admin: AccountContext = {
    accountId: sandbox.id,
    actorId: await seatFor(sandbox.id, SANDBOX.slug),
    actorKind: 'user',
    isSuperAdmin: true,
    viewHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
    editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
  }
  adminCtx = admin
  const other: AccountContext = {
    accountId: peer.id,
    actorId: await seatFor(peer.id, PEER.slug),
    actorKind: 'user',
    isSuperAdmin: true,
    viewHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
    editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
  }

  const save = async (input: Parameters<typeof saveAutomation>[1]): Promise<string> => {
    const { id } = await saveAutomation(admin, input)
    if (!made.includes(id)) made.push(id)
    return id
  }

  const task = { kind: 'action' as const, type: 'create_task' as const, config: { title: 'Chase {{name}}' } }

  // ------------------------------------------------------------- triggers

  await check('a date rule names a date field, an offset and a side', async () => {
    const id = await save({
      name: `Renewal ${stamp}`,
      trigger: 'date_reached',
      objectKey: 'deal',
      triggerConfig: { fieldKey: 'close_date', offsetDays: 3, direction: 'before' },
      conditions: [],
      steps: [task],
    })
    return `saved ${id.slice(0, 8)}`
  })

  await check('and a rule pointed at something that is not a date is refused', async () => {
    const message = await refuses('a date rule on a name field', () =>
      save({
        name: `Bad date ${stamp}`,
        trigger: 'date_reached',
        objectKey: 'deal',
        triggerConfig: { fieldKey: 'name', offsetDays: 1, direction: 'before' },
        conditions: [],
        steps: [task],
      }),
    )
    expect(message.includes('not a date'), message)
    return message
  })

  await check('a silence rule needs a number of days inside a year', async () => {
    const message = await refuses('a silence rule with no days', () =>
      save({
        name: `Bad silence ${stamp}`,
        trigger: 'no_activity',
        objectKey: 'contact',
        triggerConfig: {},
        conditions: [],
        steps: [task],
      }),
    )
    expect(message.includes('days of silence'), message)
    return message
  })

  await check('a date rule finds the record whose date lands today, and only that one', async () => {
    const hit = await createRecord(admin, 'deal', {
      name: `Scan hit ${stamp}`,
      close_date: dayUtc(3),
    })
    const miss = await createRecord(admin, 'deal', {
      name: `Scan miss ${stamp}`,
      close_date: dayUtc(9),
    })
    const id = await save({
      name: `Three days out ${stamp}`,
      trigger: 'date_reached',
      objectKey: 'deal',
      triggerConfig: { fieldKey: 'close_date', offsetDays: 3, direction: 'before' },
      conditions: [],
      steps: [task],
      isActive: true,
    })
    const rule = (await armedScans(admin)).find((row) => row.id === id)
    expect(rule !== undefined, 'an active date rule was not armed for the scan')
    const found = await scanTargets(admin, rule!, dayUtc(0))
    expect(found.includes(hit.id), 'the deal closing in three days was not found')
    expect(!found.includes(miss.id), 'a deal closing in nine days was found by a three-day rule')
    return `${found.length} matched`
  })

  await check('a silence rule fires on the day the record goes quiet, not every day after', async () => {
    const crossing = await createRecord(admin, 'contact', { email: `quiet-${stamp}@sandbox.test` })
    const longGone = await createRecord(admin, 'contact', { email: `gone-${stamp}@sandbox.test` })
    // Written through the owner pool because "twenty days ago" is not something
    // any write path will accept.
    await owner`update contact set created_at = now() - interval '20 days' where id = ${crossing.id}`
    await owner`update contact set created_at = now() - interval '90 days' where id = ${longGone.id}`
    // Creating a contact can enter it into a segment, and that writes a timeline
    // entry dated now. Silence is measured from the last entry there, so a record
    // whose creation is old and whose only entry is new is not quiet at all.
    await owner`
      update activity_link set occurred_at = now() - interval '20 days'
       where entity_type = 'contact' and entity_id = ${crossing.id}`
    await owner`
      update activity_link set occurred_at = now() - interval '90 days'
       where entity_type = 'contact' and entity_id = ${longGone.id}`

    const id = await save({
      name: `Twenty days quiet ${stamp}`,
      trigger: 'no_activity',
      objectKey: 'contact',
      triggerConfig: { days: 20 },
      conditions: [],
      steps: [task],
      isActive: true,
    })
    const rule = (await armedScans(admin)).find((row) => row.id === id)!
    const found = await scanTargets(admin, rule, dayUtc(0))
    expect(found.includes(crossing.id), 'the contact crossing twenty days of silence was not found')
    expect(!found.includes(longGone.id), 'a contact quiet for ninety days fired a twenty-day rule again')
    return 'the crossing day only'
  })

  await check('a rule that is switched off is not scanned at all', async () => {
    const armedBefore = (await armedScans(admin)).length
    const id = await save({
      name: `Parked scan ${stamp}`,
      trigger: 'no_activity',
      objectKey: 'contact',
      triggerConfig: { days: 30 },
      conditions: [],
      steps: [task],
      isActive: true,
    })
    expect((await armedScans(admin)).length === armedBefore + 1, 'an armed rule was missing from the scan')
    await setAutomationActive(admin, id, false)
    expect(
      !(await armedScans(admin)).some((row) => row.id === id),
      'a rule that was switched off was still scanned',
    )
    return 'off means off'
  })

  // ------------------------------------------------------------ once a day

  await check('a scanned rule opens one run per record per day', async () => {
    const target = await createRecord(admin, 'contact', { email: `once-${stamp}@sandbox.test` })
    const automationId = await save({
      name: `Once a day ${stamp}`,
      trigger: 'no_activity',
      objectKey: 'contact',
      triggerConfig: { days: 45 },
      conditions: [],
      steps: [task],
    })
    const day = dayUtc(0)
    const first = await openScannedRun(admin, {
      automationId,
      entityType: 'contact',
      entityId: target.id,
      scanDay: day,
    })
    expect(first !== null, 'the first scan of the day opened no run')
    const second = await openScannedRun(admin, {
      automationId,
      entityType: 'contact',
      entityId: target.id,
      scanDay: day,
    })
    expect(second === null, 'the same rule fired twice for one record in one day')
    const tomorrow = await openScannedRun(admin, {
      automationId,
      entityType: 'contact',
      entityId: target.id,
      scanDay: dayUtc(1),
    })
    expect(tomorrow !== null, 'a rule could not fire again the next day')
    return 'twice in one day is once'
  })

  // --------------------------------------------------------------- actions

  await check('the two actions that write to a person are refused on a deal', async () => {
    const message = await refuses('an email step on a deal rule', () =>
      save({
        name: `Deal mail ${stamp}`,
        trigger: 'record_created',
        objectKey: 'deal',
        conditions: [],
        steps: [{ kind: 'action', type: 'send_email', config: { templateId: 'x', mailboxId: 'y' } }],
      }),
    )
    expect(message.includes('Only a contact'), message)
    return message
  })

  await check('an email step names a template and a mailbox', async () => {
    const message = await refuses('an email step with no template', () =>
      save({
        name: `Naked mail ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [],
        steps: [{ kind: 'action', type: 'send_email', config: {} }],
      }),
    )
    expect(message.includes('no template'), message)
    return message
  })

  await check('a webhook step is https and signed', async () => {
    const plain = await refuses('an http webhook', () =>
      save({
        name: `Plain hook ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [],
        steps: [{ kind: 'action', type: 'webhook', config: { url: 'http://example.test/hook', secret: 'shh' } }],
      }),
    )
    expect(plain.includes('https'), plain)

    const unsigned = await refuses('an unsigned webhook', () =>
      save({
        name: `Unsigned hook ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [],
        steps: [{ kind: 'action', type: 'webhook', config: { url: 'https://example.test/hook' } }],
      }),
    )
    expect(unsigned.includes('secret'), unsigned)
    return `${plain} / ${unsigned}`
  })

  // -------------------------------------------------------------- branches

  await check('a branch saves both arms and each arm is checked', async () => {
    const id = await save({
      name: `Fork ${stamp}`,
      trigger: 'record_created',
      objectKey: 'contact',
      conditions: [],
      steps: [
        {
          kind: 'branch',
          conditions: [{ conjunction: 'and', conditions: [{ field: 'email', operator: 'is_not_empty' }] }],
          matched: [task],
          otherwise: [{ kind: 'delay', minutes: 60 }, task],
        },
      ],
    })
    const message = await refuses('a branch arm holding an unusable guard', () =>
      save({
        id,
        name: `Fork ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [],
        steps: [
          {
            kind: 'branch',
            conditions: [],
            matched: [
              { kind: 'guard', conditions: [{ conjunction: 'and', conditions: [{ field: 'nope', operator: 'is', value: 'x' }] }] },
              task,
            ],
            otherwise: [],
          },
        ],
      }),
    )
    expect(message.toLowerCase().includes('nope'), message)
    return message
  })

  await check('a rule whose every step is a wait or a check is refused, arms included', async () => {
    const message = await refuses('a rule that only branches', () =>
      save({
        name: `All talk ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [],
        steps: [{ kind: 'branch', conditions: [], matched: [{ kind: 'delay', minutes: 60 }], otherwise: [] }],
      }),
    )
    expect(message.includes('Add an action'), message)
    return message
  })

  // ------------------------------------------------------------ step paths

  await check('a run parks inside a branch arm and wakes up in it', async () => {
    const automationId = await save({
      name: `Deep park ${stamp}`,
      trigger: 'record_created',
      objectKey: 'contact',
      conditions: [],
      steps: [task],
    })
    const target = await createRecord(admin, 'contact', { email: `deep-${stamp}@sandbox.test` })
    const runId = await openScannedRun(admin, {
      automationId,
      entityType: 'contact',
      entityId: target.id,
      scanDay: dayUtc(2),
    })
    expect(runId !== null, 'no run to park')

    await parkAutomationRun(admin, runId!, {
      stepPath: [1, 'otherwise', 0],
      resumeAt: new Date(Date.now() - 1000),
      trail: ['it did not match, so took the other road', 'waited 1 hour'],
    })
    const claimed = await claimAutomationRun(admin, runId!)
    expect(claimed !== null, 'a due run was not claimed')
    expect(
      JSON.stringify(claimed!.stepPath) === JSON.stringify([1, 'otherwise', 0]),
      `resumed at ${JSON.stringify(claimed!.stepPath)}, not where it parked`,
    )
    expect(claimed!.trail.length === 2, 'the trail was lost across the wait')
    expect((await claimAutomationRun(admin, runId!)) === null, 'two workers both claimed one run')

    await finishAutomationRun(admin, runId!, {
      state: 'done',
      stepPath: [2],
      trail: ['it did not match, so took the other road', 'waited 1 hour', 'created "Chase"'],
    })
    const [row] = await listAutomationRuns(admin, { automationId })
    expect(row?.resumeAt === null, 'a finished run stayed in the queue')
    expect(row?.trail.length === 3, 'the trail did not survive the finish')
    return 'parked, claimed once, and finished where it got to'
  })

  // ------------------------------------------------------------- the log

  await check('the log filters by state and names the record', async () => {
    const automationId = await save({
      name: `Logged ${stamp}`,
      trigger: 'record_created',
      objectKey: 'contact',
      conditions: [],
      steps: [task],
    })
    const target = await createRecord(admin, 'contact', {
      email: `logged-${stamp}@sandbox.test`,
      first_name: 'Log',
      last_name: 'Reader',
    })
    const runId = await openScannedRun(admin, {
      automationId,
      entityType: 'contact',
      entityId: target.id,
      scanDay: dayUtc(3),
    })
    await finishAutomationRun(admin, runId!, {
      state: 'skipped',
      stepPath: [0],
      trail: [],
      detail: 'The conditions did not hold for this record.',
    })

    const skipped = await listAutomationRuns(admin, { automationId, state: 'skipped' })
    expect(skipped.length === 1, `${skipped.length} skipped runs, expected 1`)
    expect(skipped[0]?.entityName === 'Log Reader', `named the record "${skipped[0]?.entityName}"`)
    const waiting = await listAutomationRuns(admin, { automationId, state: 'waiting' })
    expect(waiting.length === 0, 'a finished run was listed as waiting')
    return 'state filter and record name both hold'
  })

  await check('the log pages rather than handing over everything', async () => {
    const first = await listAutomationRuns(admin, { limit: 1 })
    const second = await listAutomationRuns(admin, { limit: 1, offset: 1 })
    expect(first.length <= 1 && second.length <= 1, 'the limit was ignored')
    expect(
      first[0] === undefined || second[0] === undefined || first[0].id !== second[0].id,
      'the second page repeated the first',
    )
    return 'limit and offset both apply'
  })

  await check('another tenant sees none of this', async () => {
    const theirs = await listAutomationRuns(other, { limit: 200 })
    const ours = await listAutomationRuns(admin, { limit: 200 })
    const overlap = theirs.filter((run) => ours.some((mine) => mine.id === run.id))
    expect(overlap.length === 0, `${overlap.length} runs visible to both tenants`)
    expect(!(await armedScans(other)).some((rule) => made.includes(rule.id)), 'a rule leaked across tenants')
    return `${theirs.length} of its own, none of Sandbox's`
  })

  console.log('')
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log('all automation trigger, action, branch and run-log checks passed.')
  }
} finally {
  // The rules themselves live in a seeded table, which cleanup leaves alone, so
  // this suite takes back exactly what it made. Their runs go with them.
  for (const id of made) {
    if (adminCtx) await removeAutomation(adminCtx, id).catch(() => {})
  }
  await owner.end()
  await closeAppPool()
  await cleanup()
}
