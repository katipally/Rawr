import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import { canEdit, type AccountContext } from '../src/dal/context.ts'
import {
  createField,
  deleteField,
  fieldUsage,
  moveFieldsToGroup,
  refreshFillRates,
  renameFieldGroup,
  listDeletedFields,
  listFields,
  purgeField,
  reorderFields,
  restoreField,
  updateField,
} from '../src/dal/admin-fields.ts'
import { matchesConditional } from '../src/registry/conditional.ts'
import { promoteFieldToHot } from '../src/dal/fields.ts'
import {
  listAutomations,
  removeAutomation,
  saveAutomation,
  setAutomationActive,
} from '../src/dal/automations.ts'
import {
  createLifecycleStage,
  createPipeline,
  createStage,
  deleteLifecycleStage,
  deletePipeline,
  deleteStage,
  listLifecycleStages,
  listPipelines,
  renameLifecycleStage,
  renamePipeline,
  reorderLifecycleStages,
  reorderStages,
  updateStage,
} from '../src/dal/pipelines.ts'
import {
  createSubscriptionType,
  deleteSubscriptionType,
  listSubscriptionTypes,
  updateSubscriptionType,
} from '../src/dal/subscriptions.ts'
import {
  deleteSegment,
  evaluateSegment,
  listSegments,
  previewSegment,
  readMemberships,
  readSegmentMembers,
  saveSegment,
} from '../src/dal/segments.ts'
import { bulkUpdateRecords, createRecord, getRecord, updateRecord } from '../src/dal/records.ts'
import { readTimeline } from '../src/dal/activity.ts'
import { readBoard, groupableFields } from '../src/dal/board.ts'
import { recordOptions } from '../src/dal/search.ts'
import { forgetRegistry, getRegistry, objectOrThrow } from '../src/dal/registry.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import { SANDBOX, PEER, cleanup } from './fixture.ts'

/** The parts of F1 that had no code: the metadata registry's write side, pipeline
 *  and lifecycle administration, subscription types, segments, bulk edit, board
 *  grouping and the searched pickers. */

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
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)
    fail(what, detail)
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
  const [datasaur] = await db.select().from(s.account).where(eq(s.account.slug, SANDBOX.slug))
  const [probe] = await db.select().from(s.account).where(eq(s.account.slug, PEER.slug))
  if (!datasaur || !probe) throw new Error('Run pnpm db:seed first.')

  const members = await db
    .select({
      id: s.userAccount.id,
      email: s.userAccount.email,
      isSuperAdmin: s.membership.isSuperAdmin,
      viewHubs: s.membership.viewHubs,
      editHubs: s.membership.editHubs,
    })
    .from(s.membership)
    .innerJoin(s.userAccount, eq(s.userAccount.id, s.membership.userId))
    .where(eq(s.membership.accountId, datasaur.id))

  /** The seeded seats are named for the access they carry, so the suite asks for
   *  one by name and gets whatever grants the seed gave it. */
  const ctxFor = (seat: string): AccountContext => {
    const member = members.find((m) => m.email === `${seat}@sandbox.test`)
    if (!member) throw new Error(`no seeded ${seat}`)
    return {
      accountId: datasaur.id,
      actorId: member.id,
      actorKind: 'user',
      isSuperAdmin: member.isSuperAdmin,
      viewHubs: member.viewHubs,
      editHubs: member.editHubs,
    }
  }

  const admin = ctxFor('admin')
  const sales = ctxFor('sales')
  const marketing = ctxFor('marketing')
  const viewer = ctxFor('viewer')
  const probeCtx: AccountContext = {
    accountId: probe.id,
    actorId: null,
    actorKind: 'user',
    isSuperAdmin: true,
    viewHubs: [],
    editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
  }

  console.log('-- the registry has a write side -------------------------------')

  const fieldKey = `verify_risk_${stamp}`
  let fieldId = ''

  await check('a custom field can be created without a deploy', async () => {
    const created = await createField(admin, {
      objectKey: 'deal',
      key: fieldKey,
      label: 'Verify renewal risk',
      type: 'select',
      options: ['Low', 'Medium', 'High'],
      helpText: 'Written by verify-admin.',
    })
    fieldId = created.id
    expect(created.storage === 'jsonb', 'a new field must be jsonb-stored')
    return `${created.key} is a ${created.type} on deal`
  })

  await check('and it appears in the registry immediately', async () => {
    forgetRegistry(datasaur.id)
    const registry = await getRegistry(admin)
    const object = objectOrThrow(registry, 'deal')
    expect(object.byKey.has(fieldKey), 'the new field is not in the registry')
    return 'every surface reads this list, so it is on the record editor too'
  })

  await check('a record can hold a value for it', async () => {
    const deals = await recordOptions(admin, { object: 'deal', limit: 1 })
    const target = deals[0]
    expect(Boolean(target), 'no deal to write to')
    await updateRecord(admin, 'deal', target!.id, { [fieldKey]: 'High' })
    const record = await getRecord(admin, 'deal', target!.id)
    expect(record?.values[fieldKey] === 'High', `stored ${String(record?.values[fieldKey])}`)
    return `${target!.label} now has ${fieldKey} = High`
  })

  await check('a value outside the choices is refused', async () => {
    const deals = await recordOptions(admin, { object: 'deal', limit: 1 })
    const message = await refuses('an invalid choice', () =>
      updateRecord(admin, 'deal', deals[0]!.id, { [fieldKey]: 'Catastrophic' }),
    )
    return message
  })

  await check('the label can change and the key cannot', async () => {
    await updateField(admin, { id: fieldId, label: 'Verify renewal risk (renamed)' })
    forgetRegistry(datasaur.id)
    const fields = await listFields(admin, 'deal')
    const found = fields.find((field) => field.id === fieldId)
    expect(found?.label === 'Verify renewal risk (renamed)', 'the label did not change')
    expect(found?.key === fieldKey, 'the key changed, which would orphan every stored value')
    return 'renaming a label never touches data'
  })

  await check('a core field cannot be deleted', async () => {
    const fields = await listFields(admin, 'deal')
    const core = fields.find((field) => field.key === 'amount')
    return await refuses('deleting a core field', () => deleteField(admin, core!.id))
  })

  await check('a system field cannot be edited or written', async () => {
    const fields = await listFields(admin, 'contact')
    const created = fields.find((field) => field.key === 'created_at')
    expect(created?.isSystem === true, 'created_at is not marked as a system field')
    const one = await recordOptions(admin, { object: 'contact', limit: 1 })
    const message = await refuses('writing created_at', () =>
      updateRecord(admin, 'contact', one[0]!.id, { created_at: new Date('2020-01-01') }),
    )
    return message
  })

  await check('deleting a custom field says what is at stake first', async () => {
    const usage = await fieldUsage(admin, fieldId)
    expect(usage.filled === 1, `${usage.filled} records hold a value, expected 1`)
    return `${usage.filled} record holds a value`
  })

  await check('delete hides it everywhere and keeps the data', async () => {
    await deleteField(admin, fieldId)
    forgetRegistry(datasaur.id)
    const registry = await getRegistry(admin)
    expect(!objectOrThrow(registry, 'deal').byKey.has(fieldKey), 'the deleted field is still in the registry')
    const [row] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from deal where custom ? ${fieldKey}`,
    )
    expect(Number(row?.n) === 1, 'the value was removed by a soft delete')
    return 'hidden immediately, value still present'
  })

  await check('and restore puts it back exactly as it was', async () => {
    const deleted = await listDeletedFields(admin)
    expect(deleted.some((field) => field.id === fieldId), 'the deleted field is not listed')
    await restoreField(admin, fieldId)
    forgetRegistry(datasaur.id)
    const registry = await getRegistry(admin)
    expect(objectOrThrow(registry, 'deal').byKey.has(fieldKey), 'restore did not bring it back')
    return 'nobody loses data by misclicking'
  })

  await check('purge is refused until it has been deleted', async () => {
    return await refuses('purging a live field', () => purgeField(admin, fieldId))
  })

  await check('purge strips the value out of every record', async () => {
    await deleteField(admin, fieldId)
    const result = await purgeField(admin, fieldId)
    expect(result.stripped === 1, `stripped ${result.stripped}, expected 1`)
    const [row] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from deal where custom ? ${fieldKey}`,
    )
    expect(Number(row?.n) === 0, 'the value survived the purge')
    return `${result.stripped} record cleared, definition gone`
  })

  await check('a key that would collide with Postgres is refused', async () =>
    refuses('a reserved key', () =>
      createField(admin, { objectKey: 'deal', key: 'select', label: 'Select', type: 'text' }),
    ),
  )

  await check('reordering fields is a real edit', async () => {
    const before = await listFields(admin, 'company')
    const flipped = [before[1]!.id, before[0]!.id, ...before.slice(2).map((field) => field.id)]
    await reorderFields(admin, 'company', flipped)
    const after = await listFields(admin, 'company')
    expect(after[0]!.id === before[1]!.id, 'the order did not change')
    // Put it back so the seeded account reads the way it started.
    await reorderFields(admin, 'company', before.map((field) => field.id))
    return 'position drives the record page and the picker'
  })

  await check('a viewer cannot change the registry', async () =>
    refuses('a viewer creating a field', () =>
      createField(viewer, { objectKey: 'deal', key: `v_${stamp}`, label: 'Nope', type: 'text' }),
    ),
  )

  console.log('')
  console.log('-- groups, fill rate and conditional logic ----------------------')

  const groupA = `Verify group A ${stamp}`
  const groupB = `Verify group B ${stamp}`
  let groupedId = ''

  await check('a group exists once a property names it, and renames on every one', async () => {
    const first = await createField(admin, {
      objectKey: 'contact',
      key: `grp_a_${stamp}`,
      label: `Grouped A ${stamp}`,
      type: 'text',
      groupName: groupA,
    })
    groupedId = first.id
    const second = await createField(admin, {
      objectKey: 'contact',
      key: `grp_b_${stamp}`,
      label: `Grouped B ${stamp}`,
      type: 'text',
      groupName: groupA,
    })

    const renamed = await renameFieldGroup(admin, 'contact', groupA, groupB)
    expect(renamed.moved === 2, `the rename moved ${renamed.moved} properties, expected 2`)
    const after = await listFields(admin, 'contact')
    expect(
      after.filter((field) => field.groupName === groupB).length === 2,
      'the properties did not follow the rename',
    )

    const moved = await moveFieldsToGroup(admin, 'contact', [second.id], null)
    expect(moved.moved === 1, `the move touched ${moved.moved} properties`)
    const ungrouped = (await listFields(admin, 'contact')).find((field) => field.id === second.id)
    expect(ungrouped?.groupName === null, `it landed in ${String(ungrouped?.groupName)}`)

    await deleteField(admin, second.id)
    return 'named into being, renamed on every property, moved out again'
  })

  await check('a property outside the object cannot be moved into its groups', async () =>
    refuses('a deal property moved on the contact object', () =>
      moveFieldsToGroup(admin, 'contact', [randomUUID()], groupB),
    ),
  )

  await check('the fill rate is a stored count with the time it was taken', async () => {
    const before = (await listFields(admin, 'contact')).find((field) => field.id === groupedId)
    expect(before?.filledCount === null, `it started at ${String(before?.filledCount)}`)

    const { fields } = await refreshFillRates(admin)
    expect(fields > 0, 'the sweep counted nothing')

    const after = (await listFields(admin, 'contact')).find((field) => field.id === groupedId)
    expect(after?.filledCount === 0, `nothing holds a value and it read ${String(after?.filledCount)}`)
    expect(after?.filledAt !== null, 'the count carries no time')

    const email = (await listFields(admin, 'contact')).find((field) => field.key === 'email')
    expect((email?.filledCount ?? 0) > 0, `every seeded contact has an address and email read ${String(email?.filledCount)}`)
    return `${fields} propert(ies) counted in one pass per object`
  })

  await check('a conditional rule is stored, read back and refused when it cannot match', async () => {
    await updateField(admin, {
      id: groupedId,
      conditional: { conjunction: 'and', conditions: [{ field: 'lead_status', operator: 'is', value: 'New' }] },
    })
    const saved = (await listFields(admin, 'contact')).find((field) => field.id === groupedId)
    expect(saved?.conditional?.conditions.length === 1, 'the rule did not come back')
    expect(saved?.conditional?.conditions[0]?.field === 'lead_status', 'the rule came back naming another field')

    await refuses('a property conditioned on itself', () =>
      updateField(admin, {
        id: groupedId,
        conditional: { conjunction: 'and', conditions: [{ field: `grp_a_${stamp}`, operator: 'is', value: 'x' }] },
      }),
    )
    await refuses('a property conditioned on a field that is not there', () =>
      updateField(admin, {
        id: groupedId,
        conditional: { conjunction: 'and', conditions: [{ field: 'no_such_field', operator: 'is', value: 'x' }] },
      }),
    )

    await updateField(admin, { id: groupedId, conditional: null })
    const cleared = (await listFields(admin, 'contact')).find((field) => field.id === groupedId)
    expect(cleared?.conditional === null, 'the rule could not be cleared')
    return 'stored, refused on itself and on a field that is not there, cleared'
  })

  await check('the rule decides visibility the same way everywhere', async () => {
    const rule = { conjunction: 'and' as const, conditions: [{ field: 'lead_status', operator: 'is' as const, value: 'New' }] }
    expect(matchesConditional(rule, { lead_status: 'New' }), 'a matching value hid the property')
    expect(!matchesConditional(rule, { lead_status: 'Open' }), 'a different value showed it')
    expect(!matchesConditional(rule, {}), 'an empty record showed it')
    expect(matchesConditional(null, {}), 'a property with no rule was hidden')
    const any = { conjunction: 'or' as const, conditions: [{ field: 'stage', operator: 'in' as const, value: ['a', 'b'] }] }
    expect(matchesConditional(any, { stage: 'b' }), '"is any of" missed a member')
    expect(!matchesConditional(any, { stage: 'c' }), '"is any of" matched a non-member')
    return 'is, is any of, empty and no rule'
  })

  await check('used in names the assets that would break', async () => {
    const use = await fieldUsage(admin, groupedId)
    expect(Array.isArray(use.usedIn), 'usage did not report what uses it')
    const email = (await listFields(admin, 'contact')).find((field) => field.key === 'email')!
    const emailUse = await fieldUsage(admin, email.id)
    expect(emailUse.usedIn.length > 0, 'the seeded forms and segments name no field')
    return `a brand new property is used in ${use.usedIn.length}; email in ${emailUse.usedIn.length}`
  })

  await check('a property in a group can still be deleted and purged', async () => {
    await deleteField(admin, groupedId)
    await purgeField(admin, groupedId)
    const gone = (await listFields(admin, 'contact')).find((field) => field.id === groupedId)
    expect(gone === undefined, 'it is still on the list')
    return 'the group is a name on a property and goes with it'
  })

  console.log('')
  console.log('-- pipelines and stages ----------------------------------------')

  let pipelineId = ''
  let stageA = ''
  let stageB = ''

  await check('a pipeline and its stages can be created', async () => {
    const created = await createPipeline(admin, `Verify pipeline ${stamp}`)
    pipelineId = created.id
    stageA = (await createStage(admin, { pipelineId, name: 'First', probability: 10 })).id
    stageB = (await createStage(admin, { pipelineId, name: 'Second', probability: 60 })).id
    const pipelines = await listPipelines(admin)
    const found = pipelines.find((row) => row.id === pipelineId)
    expect(found?.stages.length === 2, `${found?.stages.length} stages`)
    return '2 stages, with probabilities'
  })

  await check('a stage cannot be both closed won and closed lost', async () =>
    refuses('a stage that is both', () =>
      updateStage(admin, { id: stageA, isClosedWon: true, isClosedLost: true }),
    ),
  )

  await check('a probability outside 0 to 100 is refused', async () =>
    refuses('a probability of 140', () => updateStage(admin, { id: stageA, probability: 140 })),
  )

  await check('stages reorder', async () => {
    await reorderStages(admin, pipelineId, [stageB, stageA])
    const pipelines = await listPipelines(admin)
    const found = pipelines.find((row) => row.id === pipelineId)
    expect(found?.stages[0]?.id === stageB, 'the order did not change')
    return 'position is what the board lays out'
  })

  let movedDeal = ''

  await check('a stage holding deals cannot be deleted without a destination', async () => {
    const created = await createRecord(admin, 'deal', {
      name: `Verify stage move ${stamp}`,
      pipeline_id: pipelineId,
      stage_id: stageA,
    })
    movedDeal = created.id
    return await refuses('deleting a stage with deals in it', () => deleteStage(admin, stageA, null))
  })

  await check('and deleting it with one moves every deal', async () => {
    const result = await deleteStage(admin, stageA, stageB)
    expect(result.moved === 1, `moved ${result.moved}`)
    const record = await getRecord(admin, 'deal', movedDeal)
    expect(record?.values.stage_id === stageB, 'the deal did not move')
    return `${result.moved} deal moved to Second`
  })

  await check('and each move is on the deal timeline', async () => {
    const timeline = await readTimeline(admin, {
      entity: { entityType: 'deal', entityId: movedDeal },
      types: ['stage_change'],
    })
    expect(timeline.rows.length > 0, 'no stage_change was written')
    return timeline.rows[0]!.subject ?? ''
  })

  await check('a pipeline with deals in it cannot be deleted', async () =>
    refuses('deleting a pipeline that holds deals', () => deletePipeline(admin, pipelineId)),
  )

  await check('and it can once it is empty', async () => {
    await db.execute(sql`delete from activity_link where entity_id = ${movedDeal}`)
    await db.execute(sql`delete from deal where id = ${movedDeal}`)
    await deletePipeline(admin, pipelineId)
    const pipelines = await listPipelines(admin)
    expect(!pipelines.some((row) => row.id === pipelineId), 'the pipeline survived')
    return 'stages went with it'
  })

  await check('the last pipeline cannot be deleted', async () => {
    const pipelines = await listPipelines(admin)
    const empty = pipelines.find((row) => row.dealCount === 0)
    if (!empty) return 'every remaining pipeline holds deals, which is refused for its own reason'
    return await refuses('deleting the only pipeline', async () => {
      // Only meaningful when one is left; with several this refuses for the
      // deal-count reason instead, which is also correct.
      for (const row of pipelines) if (row.id !== empty.id) await deletePipeline(admin, row.id)
      await deletePipeline(admin, empty.id)
    })
  })

  console.log('')
  console.log('-- lifecycle and subscriptions ---------------------------------')

  await check('a lifecycle stage can be created and deleted', async () => {
    const created = await createLifecycleStage(admin, `Verify stage ${stamp}`)
    const rows = await listLifecycleStages(admin)
    expect(rows.some((row) => row.id === created.id), 'the stage was not created')
    await deleteLifecycleStage(admin, created.id, null)
    return `${rows.length} stages, ordered`
  })

  await check('one that records point at needs a destination', async () => {
    const rows = await listLifecycleStages(admin)
    const used = rows.find((row) => row.usedBy > 0)
    if (!used) return 'no seeded lifecycle stage is in use, so nothing to move'
    return await refuses('deleting a lifecycle stage in use', () =>
      deleteLifecycleStage(admin, used.id, null),
    )
  })

  await check('a subscription type can be created', async () => {
    const created = await createSubscriptionType(marketing, {
      name: `Verify type ${stamp}`,
      description: 'Written by verify-admin.',
    })
    const rows = await listSubscriptionTypes(marketing)
    expect(rows.some((row) => row.id === created.id), 'the type was not created')
    await deleteSubscriptionType(marketing, created.id, 0)
    return `${rows.length} types`
  })

  await check('deleting one that carries opt-outs must confirm the number', async () => {
    const rows = await listSubscriptionTypes(admin)
    const withOptOuts = rows.find((row) => row.unsubscribed > 0)
    if (!withOptOuts) return 'no seeded type carries an opt-out'
    return await refuses('discarding opt-outs without confirming', () =>
      deleteSubscriptionType(admin, withOptOuts.id, 0),
    )
  })

  await check('a viewer cannot manage subscription types', async () =>
    refuses('a viewer creating a subscription type', () =>
      createSubscriptionType(viewer, { name: 'Nope' }),
    ),
  )

  console.log('')
  console.log('-- settings mutations are an admin\'s ---------------------------')

  /** Somebody who can edit contacts and nothing else. Built here rather than
   *  seeded, so the check does not wait on a seat existing. */
  const contactsOnly: AccountContext = {
    ...admin,
    isSuperAdmin: false,
    viewHubs: ['reports'],
    editHubs: ['contacts'],
  }

  await check('the gate the router now puts these mutations behind refuses it', async () => {
    expect(!canEdit(contactsOnly, 'account'), 'a contacts-only seat passed the account check')
    expect(canEdit(admin, 'account'), 'the admin seat failed the account check')
    return 'canEdit(ctx, "account") is false for contacts-only and true for admin'
  })

  await check('a contacts-only editor is refused on every settings mutation', async () => {
    // The grant is checked before any row is read, so an id that exists is not
    // needed to prove the refusal.
    const absent = randomUUID()
    const mutations: [string, () => Promise<unknown>][] = [
      ['fields.create', () => createField(contactsOnly, { objectKey: 'deal', key: `nope_${stamp}`, label: 'Nope', type: 'text' })],
      ['fields.update', () => updateField(contactsOnly, { id: absent, label: 'Nope' })],
      ['fields.reorder', () => reorderFields(contactsOnly, 'deal', [])],
      ['fields.remove', () => deleteField(contactsOnly, absent)],
      ['fields.restore', () => restoreField(contactsOnly, absent)],
      ['fields.promoteToHot', () => promoteFieldToHot(contactsOnly, absent)],
      ['fields.purge', () => purgeField(contactsOnly, absent)],
      ['pipelines.create', () => createPipeline(contactsOnly, 'Nope')],
      ['pipelines.rename', () => renamePipeline(contactsOnly, absent, 'Nope')],
      ['pipelines.remove', () => deletePipeline(contactsOnly, absent)],
      ['pipelines.createStage', () => createStage(contactsOnly, { pipelineId: absent, name: 'Nope' })],
      ['pipelines.updateStage', () => updateStage(contactsOnly, { id: absent, name: 'Nope' })],
      ['pipelines.reorderStages', () => reorderStages(contactsOnly, absent, [])],
      ['pipelines.removeStage', () => deleteStage(contactsOnly, absent, null)],
      ['lifecycle.create', () => createLifecycleStage(contactsOnly, 'Nope')],
      ['lifecycle.rename', () => renameLifecycleStage(contactsOnly, absent, 'Nope')],
      ['lifecycle.reorder', () => reorderLifecycleStages(contactsOnly, [])],
      ['lifecycle.remove', () => deleteLifecycleStage(contactsOnly, absent, null)],
      ['automations.save', () => saveAutomation(contactsOnly, { id: null, name: 'Nope', trigger: 'record_created', objectKey: 'contact', conditions: [], steps: [{ kind: 'delay', minutes: 1 }] })],
      ['automations.setActive', () => setAutomationActive(contactsOnly, absent, false)],
      ['automations.remove', () => removeAutomation(contactsOnly, absent)],
      ['subscriptionTypes.create', () => createSubscriptionType(contactsOnly, { name: 'Nope' })],
      ['subscriptionTypes.update', () => updateSubscriptionType(contactsOnly, { id: absent, name: 'Nope' })],
      ['subscriptionTypes.remove', () => deleteSubscriptionType(contactsOnly, absent, 0)],
    ]
    for (const [what, run] of mutations) {
      const message = await refuses(what, run)
      expect(message.trim().length > 0, `${what} was refused without saying why`)
    }
    return `${mutations.length} mutations refused`
  })

  await check('and the same seat still reads every settings list', async () => {
    const fields = await listFields(contactsOnly, 'deal')
    const pipelines = await listPipelines(contactsOnly)
    const stages = await listLifecycleStages(contactsOnly)
    const types = await listSubscriptionTypes(contactsOnly)
    const automations = await listAutomations(contactsOnly)
    expect(fields.length > 0, 'deal has no fields to read')
    return `${fields.length} fields, ${pipelines.length} pipelines, ${stages.length} lifecycle stages, ${types.length} subscription types, ${automations.length} automations`
  })

  console.log('')
  console.log('-- segments ----------------------------------------------------')

  let segmentId = ''

  await check('a segment with no conditions is refused', async () =>
    refuses('an empty segment', () =>
      saveSegment(marketing, {
        objectKey: 'contact',
        name: `Verify empty ${stamp}`,
        filters: [{ conjunction: 'and', conditions: [] }],
      }),
    ),
  )

  await check('a filter that cannot run is refused at save', async () =>
    refuses('a segment on a field that does not exist', () =>
      saveSegment(marketing, {
        objectKey: 'contact',
        name: `Verify broken ${stamp}`,
        filters: [{ conjunction: 'and', conditions: [{ field: 'not_a_field', operator: 'is', value: 'x' }] }],
      }),
    ),
  )

  await check('the builder previews before anything is saved', async () => {
    const preview = await previewSegment(marketing, {
      objectKey: 'contact',
      filters: [{ conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: 'partner' }] }],
    })
    expect(preview.count > 0, 'nothing matched the preview')
    return `${preview.count} match, ${preview.sample.length} shown`
  })

  await check('a segment stores its membership', async () => {
    const created = await saveSegment(marketing, {
      objectKey: 'contact',
      name: `Verify partners ${stamp}`,
      filters: [{ conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: 'partner' }] }],
    })
    segmentId = created.id
    const result = await evaluateSegment(marketing, segmentId)
    expect(result.entered > 0, 'nobody entered the segment')
    expect(result.members === result.entered, 'the member count disagrees with the entries')
    return `${result.entered} entered, ${result.members} members`
  })

  await check('and entering writes a timeline event', async () => {
    const members = await readSegmentMembers(marketing, segmentId, 1)
    const timeline = await readTimeline(marketing, {
      entity: { entityType: 'contact', entityId: members[0]!.id },
      types: ['segment_change'],
    })
    expect(timeline.rows.length > 0, 'no segment_change was written')
    return timeline.rows[0]!.subject ?? ''
  })

  await check('every member gets one, not just the first chunk', async () => {
    // The evaluator writes these in batched statements rather than one call per
    // member, which is the difference between a second and seventeen minutes on a
    // segment the size of the portal. What that rewrite could get wrong is the
    // chunk boundary, so the count is the check.
    // Counted in SQL rather than through readSegmentMembers, which pages at 200:
    // the boundary being checked is the evaluator's, not the reader's.
    const [held] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from segment_membership
       where segment_id = ${segmentId} and exited_at is null`)
    const [written] = await db.execute<{ n: number }>(sql`
      select count(distinct l.entity_id)::int as n
        from activity a
        join activity_link l on l.activity_id = a.id
       where a.account_id = ${datasaur.id}
         and a.type = 'segment_change'
         and a.subject = ${`entered Verify partners ${stamp}`}`)
    expect(
      Number(written?.n) === Number(held?.n),
      `${held?.n} members, ${written?.n} timelines say so`,
    )
    return `${held?.n} members, ${written?.n} timeline entries`
  })

  await check('leaving writes another, and the spell is kept', async () => {
    const members = await readSegmentMembers(marketing, segmentId, 1)
    const leaver = members[0]!
    await saveSegment(marketing, {
      id: segmentId,
      objectKey: 'contact',
      name: `Verify partners ${stamp}`,
      filters: [
        { conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: 'nobody-at-all' }] },
      ],
    })
    const result = await evaluateSegment(marketing, segmentId)
    expect(result.exited > 0, 'nobody left')
    expect(result.members === 0, `${result.members} still in it`)

    const history = await readMemberships(marketing, leaver.id)
    const spell = history.find((row) => row.segmentId === segmentId)
    expect(spell?.exitedAt !== null, 'the exit was not recorded, so the spell is lost')
    return `${result.exited} left, and the past spell still reads`
  })

  await check('re-entry is a new spell rather than an un-exit', async () => {
    await saveSegment(marketing, {
      id: segmentId,
      objectKey: 'contact',
      name: `Verify partners ${stamp}`,
      filters: [{ conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: 'partner' }] }],
    })
    const result = await evaluateSegment(marketing, segmentId)
    const members = await readSegmentMembers(marketing, segmentId, 1)
    const history = await readMemberships(marketing, members[0]!.id)
    const spells = history.filter((row) => row.segmentId === segmentId)
    expect(spells.length >= 2, `${spells.length} spell(s); a churn and a return must both survive`)
    return `${result.entered} re-entered, ${spells.length} spells on the record`
  })

  await check('a sales user cannot change somebody else’s list', async () =>
    refuses('a sales user saving a segment', () =>
      saveSegment(sales, {
        objectKey: 'contact',
        name: `Verify nope ${stamp}`,
        filters: [{ conjunction: 'and', conditions: [{ field: 'email', operator: 'contains', value: 'x' }] }],
      }),
    ),
  )

  await check('one tenant cannot see another’s segments', async () => {
    const theirs = await listSegments(probeCtx)
    expect(theirs.length === 0, `${theirs.length} segments leaked across tenants`)
    return 'row level security covers segment and segment_membership'
  })

  await check('deleting a segment keeps the timeline entries', async () => {
    const members = await readSegmentMembers(marketing, segmentId, 1)
    const contactId = members[0]!.id
    await deleteSegment(marketing, segmentId)
    const timeline = await readTimeline(marketing, {
      entity: { entityType: 'contact', entityId: contactId },
      types: ['segment_change'],
    })
    expect(timeline.rows.length > 0, 'the history of what happened to the contact was erased')
    return 'membership goes, what happened to the person stays'
  })

  console.log('')
  console.log('-- bulk edit, boards and pickers -------------------------------')

  await check('one field is applied to a selection', async () => {
    const deals = await recordOptions(admin, { object: 'deal', limit: 3 })
    const ids = deals.map((row) => row.id)
    const result = await bulkUpdateRecords(admin, 'deal', ids, { deal_type: 'Renewal' })
    expect(result.updated === ids.length, `${result.updated} of ${ids.length} updated`)
    expect(result.failed.length === 0, JSON.stringify(result.failed))
    return `${result.updated} deals changed in one call`
  })

  await check('a row that refuses the change is named, and the rest still save', async () => {
    const contacts = await recordOptions(admin, { object: 'contact', limit: 3 })
    const result = await bulkUpdateRecords(admin, 'contact', contacts.map((row) => row.id), {
      // Every contact would end up with the same address, so all but the first
      // collide on the unique index.
      email: `bulk-${stamp}@verify.example`,
    })
    expect(result.updated >= 1, 'nothing was written at all')
    expect(result.failed.length >= 1, 'a duplicate email was allowed')
    expect(Boolean(result.failed[0]?.displayName), 'a failure came back without a name')
    return `${result.updated} written, ${result.failed.length} named back with a reason`
  })

  await check('a read-only seat cannot bulk edit', async () => {
    const deals = await recordOptions(viewer, { object: 'deal', limit: 1 })
    const message = await refuses('a read-only seat bulk editing', () =>
      bulkUpdateRecords(viewer, 'deal', [deals[0]!.id], { deal_type: 'Renewal' }),
    )
    // The refusal names the hub that was missing, so the person reading it knows
    // what to ask for rather than which role they are not.
    expect(message.includes('sales'), message)
    return message
  })

  await check('a board groups by any select field, not just stage', async () => {
    const registry = await getRegistry(admin)
    const object = objectOrThrow(registry, 'deal')
    const groupable = groupableFields(object)
    expect(groupable.length > 1, 'only one field is groupable')
    const board = await readBoard(admin, { groupBy: 'deal_type' })
    expect(board.groupByKey === 'deal_type', `grouped by ${board.groupByKey}`)
    expect(board.columns.length > 0, 'no columns')
    return `${groupable.length} groupable fields; deal_type gives ${board.columns.length} columns`
  })

  await check('and a field that cannot group says which ones can', async () => {
    const message = await refuses('grouping by a long text field', () =>
      readBoard(admin, { groupBy: 'next_step' }),
    )
    expect(message.includes('Deal stage'), message)
    return message
  })

  await check('a picker searches rather than listing everything', async () => {
    const all = await recordOptions(admin, { object: 'company', limit: 5 })
    expect(all.length > 0, 'an empty query returned nothing')
    const target = all[0]!
    const found = await recordOptions(admin, { object: 'company', query: target.label.slice(0, 6) })
    expect(found.some((row) => row.id === target.id), `searching for "${target.label}" did not find it`)
    return `"${target.label.slice(0, 6)}" found ${found.length} of ${all.length}`
  })

  await check('and it never offers the record being merged into', async () => {
    const all = await recordOptions(admin, { object: 'contact', limit: 5 })
    const excluded = await recordOptions(admin, { object: 'contact', excludeId: all[0]!.id, limit: 5 })
    expect(!excluded.some((row) => row.id === all[0]!.id), 'the excluded record was offered')
    return 'a record cannot be merged into itself'
  })

  await check('a picker cannot reach across tenants', async () => {
    const theirs = await recordOptions(probeCtx, { object: 'contact', limit: 50 })
    const ours = await recordOptions(admin, { object: 'contact', limit: 50 })
    const overlap = theirs.filter((row) => ours.some((mine) => mine.id === row.id))
    expect(overlap.length === 0, `${overlap.length} records visible to both tenants`)
    return `${theirs.length} of its own, none of Datasaur's`
  })

  console.log('')
  if (failures > 0) {
    console.log(`${failures} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log('all admin, segment and bulk checks passed.')
  }
} finally {
  await owner.end()
  await closeAppPool()
  await cleanup()
}
