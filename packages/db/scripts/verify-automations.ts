import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import { systemContext, type AccountContext } from '../src/dal/context.ts'
import { createTask, deleteTask, listTasks, ownerForTask } from '../src/dal/tasks.ts'
import {
  armedScans,
  claimAutomationRun,
  finishAutomationRun,
  listAutomationRuns,
  openScanRun,
  openScannedRun,
  parkAutomationRun,
  readAutomation,
  removeAutomation,
  saveAutomation,
  scanTargets,
  setAutomationActive,
} from '../src/dal/automations.ts'
import { accountZone, withAccount } from '../src/dal/index.ts'
import { addDays, dayKey, zonedTimeToUtc } from '../src/dal/slots.ts'
import { openSecret } from '../src/internal/crypto.ts'
import { createRecord, updateRecord } from '../src/dal/records.ts'
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
const utcDayOf = (at: Date): string => at.toISOString().slice(0, 10)

/** Each zone sits on the far side of UTC from the other, so a predicate that reads
 *  the session's clock fails in one of them at every hour of the day. */
const SESSION_ZONES = ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']

/** Account zones far from UTC. `edgeMinute` is a minute of the local day whose UTC
 *  date is the other calendar day, so a predicate that reads the UTC day puts a
 *  moment there on the wrong day. The check asserts that premise before relying on it. */
const ACCOUNT_ZONES = [
  { zone: 'America/Los_Angeles', edgeMinute: 23 * 60 + 30 },
  { zone: 'Pacific/Kiritimati', edgeMinute: 30 },
  { zone: 'Asia/Kolkata', edgeMinute: 30 },
]

/** Sets the sandbox account's zone for `fn` and puts the seeded zone back, even when
 *  `fn` throws. The account zone is only read by the app, so this is what the app sees. */
const inAccountZone = async <T>(accountId: string, zone: string, fn: () => Promise<T>): Promise<T> => {
  const [row] = await owner<{ timezone: string }[]>`select timezone from account where id = ${accountId}`
  const saved = row!.timezone
  await owner`update account set timezone = ${zone} where id = ${accountId}`
  try {
    return await fn()
  } finally {
    await owner`update account set timezone = ${saved} where id = ${accountId}`
  }
}

/** Runs `fn` on connections whose session TimeZone is `zone`. The app pool opens
 *  its connections lazily from DATABASE_URL, so closing it and reopening with the
 *  zone as a startup parameter puts every connection it opens inside `fn` there. */
const inSessionZone = async <T>(zone: string, fn: () => Promise<T>): Promise<T> => {
  const saved = process.env.DATABASE_URL!
  const url = new URL(saved)
  url.searchParams.set('TimeZone', zone)
  await closeAppPool()
  process.env.DATABASE_URL = url.toString()
  try {
    return await fn()
  } finally {
    await closeAppPool()
    process.env.DATABASE_URL = saved
  }
}

/** Moves a contact's creation and every activity link to `at`. Silence is measured from the
 *  last link, so a date rule and a silence rule both read the same moment. */
const backdateContact = async (contactId: string, at: Date): Promise<void> => {
  await owner`update contact set created_at = ${at.toISOString()} where id = ${contactId}`
  await owner`update activity_link set occurred_at = ${at.toISOString()} where entity_type = 'contact' and entity_id = ${contactId}`
}

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

  await check('a date rule finds the record whose date lands today, and only that one, in every account zone', async () => {
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
    for (const { zone } of ACCOUNT_ZONES) {
      await inAccountZone(sandbox.id, zone, async () => {
        const accountZoneName = await accountZone(admin)
        expect(accountZoneName === zone, `the account reads ${accountZoneName}, not ${zone}`)
        const day = dayKey(new Date(), accountZoneName)
        const hit = await createRecord(admin, 'deal', { name: `Scan hit ${stamp}`, close_date: addDays(day, 3) })
        const miss = await createRecord(admin, 'deal', { name: `Scan miss ${stamp}`, close_date: addDays(day, 9) })
        for (const session of SESSION_ZONES) {
          const found = await inSessionZone(session, () => scanTargets(admin, rule!, day, accountZoneName))
          expect(found.includes(hit.id), `${zone} on ${session}: the deal closing in three days was not found`)
          expect(!found.includes(miss.id), `${zone} on ${session}: a deal closing in nine days was found by a three-day rule`)
        }
      })
    }
    return 'every account and session zone'
  })

  await check('a date rule on a datetime property lands on its account day in every zone', async () => {
    const id = await save({
      name: `Created three days ago ${stamp}`,
      trigger: 'date_reached',
      objectKey: 'contact',
      triggerConfig: { fieldKey: 'created_at', offsetDays: 3, direction: 'after' },
      conditions: [],
      steps: [task],
      isActive: true,
    })
    const rule = (await armedScans(admin)).find((row) => row.id === id)!
    for (const { zone } of ACCOUNT_ZONES) {
      await inAccountZone(sandbox.id, zone, async () => {
        const accountZoneName = await accountZone(admin)
        const day = dayKey(new Date(), accountZoneName)
        const landed = await createRecord(admin, 'contact', { email: `landed-${stamp}-${zone.split('/').pop()}@sandbox.test` })
        await backdateContact(landed.id, zonedTimeToUtc(addDays(day, -3), 12 * 60, accountZoneName))
        for (const session of SESSION_ZONES) {
          const found = await inSessionZone(session, () => scanTargets(admin, rule, day, accountZoneName))
          expect(found.includes(landed.id), `${zone} on ${session}: a datetime created three days ago was not found on its day`)
        }
      })
    }
    return 'every account and session zone'
  })

  await check('a moment late in the evening is found on the account day, not the UTC day it falls on', async () => {
    const id = await save({
      name: `Late evening ${stamp}`,
      trigger: 'date_reached',
      objectKey: 'contact',
      triggerConfig: { fieldKey: 'created_at', offsetDays: 3, direction: 'after' },
      conditions: [],
      steps: [task],
      isActive: true,
    })
    const rule = (await armedScans(admin)).find((row) => row.id === id)!
    for (const { zone, edgeMinute } of ACCOUNT_ZONES) {
      await inAccountZone(sandbox.id, zone, async () => {
        const accountZoneName = await accountZone(admin)
        const day = dayKey(new Date(), accountZoneName)
        const landedDay = addDays(day, -3)
        const at = zonedTimeToUtc(landedDay, edgeMinute, accountZoneName)
        expect(dayKey(at, accountZoneName) === landedDay, `${zone}: the premise is broken, the moment is not on ${landedDay} locally`)
        expect(utcDayOf(at) !== landedDay, `${zone}: the premise is broken, the UTC day is the same`)
        const late = await createRecord(admin, 'contact', { email: `late-${stamp}-${zone.split('/').pop()}@sandbox.test` })
        await backdateContact(late.id, at)
        for (const session of SESSION_ZONES) {
          const found = await inSessionZone(session, () => scanTargets(admin, rule, day, accountZoneName))
          expect(found.includes(late.id), `${zone} on ${session}: a moment at ${at.toISOString()} was not found on its ${landedDay} account day`)
        }
      })
    }
    return 'the account day, not the UTC day'
  })

  await check('a silence rule fires on the day the record goes quiet, not every day after, in every account zone', async () => {
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
    for (const { zone } of ACCOUNT_ZONES) {
      await inAccountZone(sandbox.id, zone, async () => {
        const accountZoneName = await accountZone(admin)
        const day = dayKey(new Date(), accountZoneName)
        const crossing = await createRecord(admin, 'contact', { email: `quiet-${stamp}-${zone.split('/').pop()}@sandbox.test` })
        const longGone = await createRecord(admin, 'contact', { email: `gone-${stamp}-${zone.split('/').pop()}@sandbox.test` })
        // Silence is measured from the last activity link, and creating a record writes
        // one dated now, so both the creation and every link are moved together.
        await backdateContact(crossing.id, zonedTimeToUtc(addDays(day, -20), 12 * 60, accountZoneName))
        await backdateContact(longGone.id, zonedTimeToUtc(addDays(day, -90), 12 * 60, accountZoneName))
        for (const session of SESSION_ZONES) {
          const found = await inSessionZone(session, () => scanTargets(admin, rule, day, accountZoneName))
          expect(found.includes(crossing.id), `${zone} on ${session}: the contact crossing twenty days of silence was not found`)
          expect(!found.includes(longGone.id), `${zone} on ${session}: a contact quiet for ninety days fired a twenty-day rule again`)
        }
      })
    }
    return 'the crossing day only, every account and session zone'
  })

  await check('a silence that began late in the account evening is counted on its own account day', async () => {
    const id = await save({
      name: `Late silence ${stamp}`,
      trigger: 'no_activity',
      objectKey: 'contact',
      triggerConfig: { days: 20 },
      conditions: [],
      steps: [task],
      isActive: true,
    })
    const rule = (await armedScans(admin)).find((row) => row.id === id)!
    for (const { zone, edgeMinute } of ACCOUNT_ZONES) {
      await inAccountZone(sandbox.id, zone, async () => {
        const accountZoneName = await accountZone(admin)
        const day = dayKey(new Date(), accountZoneName)
        const startedDay = addDays(day, -20)
        const at = zonedTimeToUtc(startedDay, edgeMinute, accountZoneName)
        expect(utcDayOf(at) !== startedDay, `${zone}: the premise is broken, the UTC day is the same`)
        const quiet = await createRecord(admin, 'contact', { email: `edge-quiet-${stamp}-${zone.split('/').pop()}@sandbox.test` })
        await backdateContact(quiet.id, at)
        for (const session of SESSION_ZONES) {
          const found = await inSessionZone(session, () => scanTargets(admin, rule, day, accountZoneName))
          expect(found.includes(quiet.id), `${zone} on ${session}: silence that began on ${startedDay} locally was not found`)
        }
      })
    }
    return 'the account day, not the UTC day'
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
    const day = dayKey(new Date(), await accountZone(admin))
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
      scanDay: addDays(day, 1),
    })
    expect(tomorrow !== null, 'a rule could not fire again the next day')
    return 'twice in one day is once'
  })

  await check('a scanned rule writes no run for a record that does not match, and fires once when it starts to match the same day', async () => {
    const automationId = await save({
      name: `Gate ${stamp}`,
      trigger: 'no_activity',
      objectKey: 'contact',
      triggerConfig: { days: 60 },
      conditions: [{ conjunction: 'and', conditions: [{ field: 'first_name', operator: 'is', value: `Gate ${stamp}` }] }],
      steps: [task],
      isActive: true,
    })
    const rule = (await armedScans(admin)).find((row) => row.id === automationId)!
    const day = dayKey(new Date(), await accountZone(admin))
    const other = await createRecord(admin, 'contact', { email: `gate-other-${stamp}@sandbox.test`, first_name: 'Someone else' })
    const match = await createRecord(admin, 'contact', { email: `gate-match-${stamp}@sandbox.test`, first_name: `Gate ${stamp}` })
    const runCount = async () => (await listAutomationRuns(admin, { automationId })).length

    expect((await openScanRun(admin, rule, other.id, day)) === null, 'a record that does not match opened a run')
    expect((await runCount()) === 0, 'a record that does not match left a row in the log')
    expect((await openScanRun(admin, rule, match.id, day)) !== null, 'a matching record opened no run')
    expect((await openScanRun(admin, rule, match.id, day)) === null, 'the same record fired twice in one day')
    await updateRecord(admin, 'contact', other.id, { first_name: `Gate ${stamp}` })
    expect((await openScanRun(admin, rule, other.id, day)) !== null, 'a record that started to match the same day did not fire')
    expect((await runCount()) === 2, `${await runCount()} runs, expected 2`)
    return 'matches only, one run each per day'
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
    expect(message.includes('"Send an email" only works on a contact'), message)
    return message
  })

  const setField = (field: string, value: unknown) => ({ kind: 'action' as const, type: 'set_field' as const, config: { field, value } })
  const saveSetField = (objectKey: 'deal' | 'contact', field: string, value: unknown) =>
    save({ name: `Set ${field} ${stamp}`, trigger: 'record_created', objectKey, conditions: [], steps: [setField(field, value)] })

  await check('a set-field step refuses a system field, a relation and marketing status, naming the field', async () => {
    const system = await refuses('set a system field', () => saveSetField('deal', 'created_at', '2026-01-01'))
    expect(system.includes('Create date cannot be set by a rule'), system)
    const relation = await refuses('set a relation', () => saveSetField('deal', 'company_id', 'x'))
    expect(relation.includes('Associated company cannot be set by a rule'), relation)
    const consent = await refuses('set marketing status', () => saveSetField('contact', 'marketing_status', 'Subscribed'))
    expect(consent.includes('Marketing contact status cannot be set by a rule'), consent)
    return system
  })

  await check('a set-field value is checked against its field type at save', async () => {
    const word = await refuses('a currency field given a word', () => saveSetField('deal', 'amount', 'abc'))
    expect(word.includes('is not a number'), word)
    const choice = await refuses('a select given a value that is not a choice', () => saveSetField('contact', 'tracking_consent', 'Maybe'))
    expect(choice.includes('is not one of its choices'), choice)
    await saveSetField('deal', 'amount', '42')
    await saveSetField('contact', 'tracking_consent', 'Never')
    return word
  })

  await check('an automation task goes to the record owner while they are a member, on the event path and the scan path alike', async () => {
    const memberId = async (name: string, state: 'active' | 'deactivated'): Promise<string> => {
      const [row] = await owner<{ id: string }[]>`
        select u.id from membership m join user_account u on u.id = m.user_id
        where m.account_id = ${sandbox.id} and u.name = ${name} and m.state = ${state}`
      if (!row) throw new Error(`the sandbox has no ${state} member called ${name}. Run pnpm db:seed first.`)
      return row.id
    }
    const sales = await memberId('Sales', 'active')
    const former = await memberId('Former', 'deactivated')
    const assignedOn = async (ctx: AccountContext, entityType: string, entityId: string): Promise<{ assigneeId: string | null; entityId: string | null; entityName: string | null }> => {
      const assigneeId = await ownerForTask(ctx, entityType, entityId)
      const { id } = await createTask(ctx, { title: `Owner rule ${stamp}`, assigneeId, entity: { entityType, entityId } })
      const [row] = (await listTasks(admin, { entity: { entityType, entityId } })).filter((task) => task.id === id)
      await deleteTask(admin, id)
      if (!row) throw new Error('the task did not come back')
      return row
    }
    const dealOwnedBy = async (ownerId: string | null): Promise<string> =>
      (await createRecord(admin, 'deal', { name: `Owner rule ${stamp}`, owner_id: ownerId })).id
    const cases = [
      { what: 'an active owner gets the task', entityId: await dealOwnedBy(sales), expected: sales },
      { what: 'a deactivated owner leaves it unassigned', entityId: await dealOwnedBy(former), expected: null },
      { what: 'a record with no owner leaves it unassigned', entityId: await dealOwnedBy(null), expected: null },
    ]
    for (const ctx of [admin, systemContext(sandbox.id)]) {
      for (const { what, entityId, expected } of cases) {
        const row = await assignedOn(ctx, 'deal', entityId)
        expect(row.assigneeId === expected, `${what}: assigned ${row.assigneeId}, expected ${expected}`)
      }
    }
    expect(
      (await assignedOn(admin, 'widget', cases[0]!.entityId)).assigneeId === null,
      'an object with no owner field was given someone',
    )
    const contact = await createRecord(admin, 'contact', {
      email: `owner-${stamp}@sandbox.test`,
      first_name: `Owned${stamp}`,
      last_name: 'Contact',
      owner_id: sales,
    })
    const onContact = await assignedOn(admin, 'contact', contact.id)
    expect(onContact.assigneeId === sales, `a contact owner got ${onContact.assigneeId}`)
    expect(onContact.entityId === contact.id, 'the task lost the record it hangs on')
    expect(onContact.entityName?.includes(`Owned${stamp}`) === true, `the task names "${onContact.entityName}"`)
    return 'owner on both paths; deactivated, none and custom object unassigned; record name kept'
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

  await check('a webhook step cannot be aimed at a private address', async () => {
    const said = await refuses('a webhook at the metadata service', () =>
      save({
        name: `Inside hook ${stamp}`,
        trigger: 'record_created',
        objectKey: 'contact',
        conditions: [],
        steps: [{ kind: 'action', type: 'webhook', config: { url: 'https://169.254.169.254/latest/meta-data', secret: 'shh' } }],
      }),
    )
    expect(said.includes('private network'), said)
    return said
  })

  await check('a webhook step secret is stored sealed, inside a branch too, and opens to what was typed', async () => {
    const hook = (secret: string) =>
      ({ kind: 'action', type: 'webhook', config: { url: 'https://example.test/hook', secret } }) as const
    const id = await save({
      name: `Sealed hook ${stamp}`,
      trigger: 'record_created',
      objectKey: 'contact',
      conditions: [],
      steps: [hook('shh-top'), { kind: 'branch', conditions: [], matched: [hook('shh-arm')], otherwise: [] }],
    })
    const [stored] = await owner<{ steps: unknown }[]>`select steps from automation where id = ${id}`
    expect(!JSON.stringify(stored?.steps).includes('shh-'), 'a signing key is readable in the row')
    const rule = await readAutomation(admin, id)
    const [top, branch] = rule?.steps ?? []
    expect(top?.kind === 'action' && openSecret(String(top.config.secret)) === 'shh-top', 'the top step did not open')
    expect(
      branch?.kind === 'branch' &&
        branch.matched[0]?.kind === 'action' &&
        openSecret(String(branch.matched[0].config.secret)) === 'shh-arm',
      'the step in the branch did not open',
    )
    // Saving what the editor handed back must keep the key, not seal the seal.
    await save({ id, name: `Sealed hook ${stamp}`, trigger: 'record_created', objectKey: 'contact', conditions: [], steps: rule?.steps ?? [] })
    const again = await readAutomation(admin, id)
    expect(JSON.stringify(again?.steps) === JSON.stringify(rule?.steps), 'saving twice changed the sealed key')
    return 'sealed at rest, opened by the runner, stable across an edit'
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
      scanDay: addDays(dayKey(new Date(), await accountZone(admin)), 2),
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
      scanDay: addDays(dayKey(new Date(), await accountZone(admin)), 3),
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

  await check('the all-runs read pages in one order across every rule, with no repeats or gaps', async () => {
    const pagedRule = await save({
      name: `Paged ${stamp}`,
      trigger: 'record_created',
      objectKey: 'contact',
      conditions: [],
      steps: [task],
    })
    const zone = await accountZone(admin)
    for (let index = 0; index < 8; index += 1) {
      const target = await createRecord(admin, 'contact', {
        email: `paged-${stamp}-${index}@sandbox.test`,
        first_name: 'Paged',
        last_name: String(index),
      })
      await openScannedRun(admin, {
        automationId: pagedRule,
        entityType: 'contact',
        entityId: target.id,
        scanDay: addDays(dayKey(new Date(), zone), 3 + index),
      })
    }

    const whole = await listAutomationRuns(admin, { limit: 60 })
    expect(whole.length > 7, `${whole.length} runs, too few to page`)
    expect(new Set(whole.map((run) => run.automationId)).size > 1, 'every run belongs to one rule')

    // Two runs with one timestamp: the order must still hold across a page boundary.
    const [first, second] = whole
    await withAccount(admin, (tx) =>
      tx.execute(sql`update automation_run set at = ${first!.at.toISOString()}::timestamptz where id = ${second!.id}::uuid`),
    )

    const paged: typeof whole = []
    for (let offset = 0; paged.length < 60; offset += 7) {
      const page = await listAutomationRuns(admin, { limit: 7, offset })
      paged.push(...page)
      if (page.length < 7) break
    }
    const ids = paged.slice(0, 60).map((run) => run.id)
    expect(new Set(ids).size === ids.length, 'a run repeated across pages')
    expect(
      ids.join() === (await listAutomationRuns(admin, { limit: 60 })).map((run) => run.id).join(),
      'the pages did not add up to the whole list',
    )
    return `${whole.length} runs across ${new Set(whole.map((run) => run.automationId)).size} rules, paged seven at a time`
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
