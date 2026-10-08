import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AccountContext, RegistryField, RegistryObject } from '@rawr/db'
import type { Lookups } from '~/server/crm.ts'
import { prepareFields } from './fields.ts'

const field = (key: string, label: string, type: RegistryField['type']) => ({ key, label, type }) as RegistryField
const FIELDS = [field('pipeline_id', 'Pipeline', 'relation'), field('stage_id', 'Deal stage', 'relation')]
const deal: RegistryObject = {
  id: 'object-deal',
  key: 'deal',
  nameSingular: 'Deal',
  namePlural: 'Deals',
  icon: null,
  isCustom: false,
  table: 'deal',
  labelFieldKey: null,
  fields: FIELDS,
  byKey: new Map(FIELDS.map((f) => [f.key, f])),
}

const lookups: Lookups = {
  users: [],
  lifecycleStages: [],
  pipelines: [
    { id: 'sales', label: 'Sales' },
    { id: 'partners', label: 'Partners' },
  ],
  stages: [
    { id: 's-sales-appt', label: 'Appointment Scheduled', pipelineId: 'sales' },
    { id: 's-sales-won', label: 'Closed Won', pipelineId: 'sales' },
    { id: 's-part-appt', label: 'Appointment Scheduled', pipelineId: 'partners' },
    { id: 's-part-intro', label: 'Intro', pipelineId: 'partners' },
  ],
}

const ctx = {} as AccountContext
const run = (input: Record<string, unknown>, currentPipelineId?: string | null) =>
  prepareFields(ctx, deal, lookups, input, '2026-10-08', currentPipelineId)

test('on edit a stage name resolves in the pipeline the deal is in', async () => {
  const { values } = await run({ stage_id: 'Appointment Scheduled' }, 'partners')
  assert.equal(values.stage_id, 's-part-appt')
})

test('on edit a pipeline named in the same call decides which stage the name is', async () => {
  const { values } = await run({ pipeline_id: 'Sales', stage_id: 'Appointment Scheduled' }, 'partners')
  assert.deepEqual(values, { pipeline_id: 'sales', stage_id: 's-sales-appt' })
})

test('on create a stage name resolves in the pipeline the call names', async () => {
  const { values } = await run({ pipeline_id: 'Partners', stage_id: 'Appointment Scheduled' })
  assert.equal(values.stage_id, 's-part-appt')
})

test('on create with no pipeline named, a stage name resolves in the first pipeline that has stages', async () => {
  const { values } = await run({ stage_id: 'Appointment Scheduled' })
  assert.equal(values.stage_id, 's-sales-appt')
})

test('a name that cannot be scoped is reported with the pipeline of each candidate', async () => {
  await assert.rejects(
    run({ stage_id: 'Appointment Scheduled', pipeline_id: 'Nowhere' }),
    /matches more than one stage: Appointment Scheduled \(Sales\), Appointment Scheduled \(Partners\)\. Nothing was changed/,
  )
})

test('an unknown stage name is reported with the stages of its pipeline', async () => {
  await assert.rejects(run({ stage_id: 'Nope' }, 'sales'), /"Nope" is not a stage here\. Valid values: Appointment Scheduled, Closed Won\./)
})

test('a stage id is taken as given, wherever its pipeline is', async () => {
  const { values } = await run({ stage_id: 's-part-appt' }, 'sales')
  assert.equal(values.stage_id, 's-part-appt')
})
