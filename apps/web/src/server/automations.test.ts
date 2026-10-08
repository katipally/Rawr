import assert from 'node:assert/strict'
import { beforeEach, describe, it, mock } from 'node:test'
import type { AccountContext, AutomationRow, AutomationStep } from '@rawr/db'

/** Every write the executor makes, by name, so each test can say what happened
 *  and what did not. The rule's steps are walked for real; only the database,
 *  Slack and the mail and webhook edges are replaced. */
const calls: Array<[string, unknown]> = []
const record = (name: string, arg: unknown) => calls.push([name, arg])
const slack: { connected: boolean } = { connected: true }
const match: { holds: boolean } = { holds: true }
let scanRecord: { displayName: string } | null = { displayName: 'Ada Lovelace' }
let scanRunId: string | null = 'run-1'

const unused = async () => {
  throw new Error('not used by these paths')
}

mock.module('@rawr/db', {
  namedExports: {
    accountZone: async () => 'UTC',
    addDays: (day: string) => day,
    armedFor: unused,
    armedScans: async () => [scanRule],
    automationEmailTemplate: unused,
    claimAutomationRun: unused,
    conditionsHold: async () => match.holds,
    createTask: async (_ctx: AccountContext, input: unknown) => record('createTask', input),
    dayKey: () => '2026-10-08',
    enroll: unused,
    fieldOrThrow: (_object: unknown, key: string) => ({ key, label: key === 'first_name' ? 'First name' : key }),
    finishAutomationRun: async (_ctx: AccountContext, runId: string, input: unknown) =>
      record('finish', { runId, ...(input as object) }),
    getRecord: async () => scanRecord,
    getRegistry: async () => ({}),
    listLifecycleStages: async () => [],
    objectOrThrow: () => ({}),
    openAutomationRun: unused,
    openScanRun: async (_ctx: AccountContext, _rule: unknown, entityId: string) => {
      record('openScanRun', entityId)
      return scanRunId
    },
    openSecret: () => '',
    ownerForTask: async () => null,
    readAutomation: unused,
    parkAutomationRun: unused,
    readMailbox: unused,
    readSubscriptions: async () => [],
    renderMergeFields: unused,
    scanTargets: async () => ['contact-1'],
    updateRecord: async (_ctx: AccountContext, _key: string, _id: string, values: unknown) =>
      record('updateRecord', values),
  },
})
mock.module('./integrations/slack.ts', {
  namedExports: { slackCredentials: async () => (slack.connected ? { kind: 'webhook' } : null) },
})
mock.module('./notify.ts', {
  namedExports: { queueHostAlert: (input: unknown) => record('queueHostAlert', input) },
})
mock.module('./background.ts', { namedExports: { inBackground: () => {} } })
mock.module('./sequences/compose.ts', { namedExports: { compose: unused } })
mock.module('./outbound.ts', { namedExports: { hostOf: () => '', outboundRequest: unused } })
mock.module('./webhook-delivery.ts', { namedExports: { signPayload: () => '' } })
mock.module('./webhooks.ts', { namedExports: { notifySubscribers: () => {} } })

const { scanAutomations, walkSteps } = await import('./automations.ts')

const ctx: AccountContext = {
  accountId: '00000000-0000-4000-8000-000000000000',
  actorId: null,
  actorKind: 'user',
  isSuperAdmin: true,
  viewHubs: [],
  editHubs: [],
}
const event = { trigger: 'stage_changed', objectKey: 'contact', entityId: 'contact-1', displayName: 'Ada Lovelace', accountSlug: 'acme' } as const

const rule = (steps: AutomationStep[]): AutomationRow =>
  ({ id: 'rule-1', name: 'Test rule', isActive: true, trigger: 'stage_changed', objectKey: 'contact', conditions: [], steps }) as unknown as AutomationRow

const scanRule = rule([{ kind: 'action', type: 'set_field', config: { field: 'first_name', value: 'Grace' } }])
const setFirstName = (value: unknown): AutomationStep => ({ kind: 'action', type: 'set_field', config: { field: 'first_name', value } })
const slackStep: AutomationStep = { kind: 'action', type: 'notify_slack', config: { message: 'Hi {{name}}' } }
const taskStep: AutomationStep = { kind: 'action', type: 'create_task', config: { title: 'Call {{name}}' } }
const guardStep: AutomationStep = { kind: 'guard', conditions: [] }

const run = (steps: AutomationStep[]) => walkSteps(ctx, event, rule(steps), 'run-1', [], [], 'Ada Lovelace')
const finished = () => calls.filter(([name]) => name === 'finish').map(([, arg]) => arg as Record<string, unknown>)
const names = () => calls.map(([name]) => name)

beforeEach(() => {
  calls.length = 0
  slack.connected = true
  match.holds = true
  scanRecord = { displayName: 'Ada Lovelace' }
  scanRunId = 'run-1'
})

describe('set_field trail', () => {
  it('names the field label and the value it set', async () => {
    await run([setFirstName('Grace')])
    assert.deepEqual(calls.find(([name]) => name === 'updateRecord'), ['updateRecord', { first_name: 'Grace' }])
    assert.deepEqual(finished(), [{ runId: 'run-1', state: 'done', stepPath: [1], trail: ['set First name to Grace'] }])
  })

  it('says nothing when the value is cleared', async () => {
    await run([setFirstName('')])
    assert.deepEqual(finished()[0]?.trail, ['set First name to nothing'])
  })
})

describe('guard stop', () => {
  it('ends the run with only its own sentence and keeps the trail apart', async () => {
    match.holds = false
    await run([setFirstName('Grace'), guardStep])
    assert.deepEqual(finished(), [
      {
        runId: 'run-1',
        state: 'skipped',
        stepPath: [1],
        trail: ['set First name to Grace'],
        detail: 'stopped: the record no longer matches',
      },
    ])
  })

  it('lets the steps after it run when the record still matches', async () => {
    await run([guardStep, setFirstName('Grace')])
    assert.deepEqual(finished()[0]?.trail, ['checked the record still matches', 'set First name to Grace'])
  })
})

describe('Slack step', () => {
  it('fails the run and runs nothing after it when Slack is not connected', async () => {
    slack.connected = false
    await run([slackStep, taskStep])
    assert.deepEqual(names(), ['finish'])
    assert.equal(finished()[0]?.state, 'failed')
    assert.equal(finished()[0]?.detail, 'Slack is not connected, so nothing was posted.')
  })

  it('queues the message and reads as queued when Slack is connected', async () => {
    await run([slackStep])
    assert.ok(names().includes('queueHostAlert'))
    assert.deepEqual(finished()[0]?.trail, ['queued a Slack message'])
  })
})

describe('scan', () => {
  it('writes no run for a record that does not match the conditions', async () => {
    scanRunId = null
    const result = await scanAutomations(ctx, 'acme')
    assert.deepEqual(names(), ['openScanRun'])
    assert.deepEqual(result, { scanned: 1, fired: 0 })
  })

  it('closes the run as skipped when the record is deleted between the open and the read', async () => {
    scanRecord = null
    const result = await scanAutomations(ctx, 'acme')
    assert.deepEqual(finished(), [
      { runId: 'run-1', state: 'skipped', stepPath: [], trail: [], detail: 'stopped: the record was deleted before it could run' },
    ])
    assert.deepEqual(result, { scanned: 1, fired: 0 })
  })

  it('walks a matching record once', async () => {
    const result = await scanAutomations(ctx, 'acme')
    assert.deepEqual(result, { scanned: 1, fired: 1 })
    assert.equal(finished()[0]?.state, 'done')
  })
})
