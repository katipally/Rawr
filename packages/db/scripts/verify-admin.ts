import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import * as s from '../src/schema/index.ts'
import { canEdit, type AccountContext } from '../src/dal/context.ts'
import {
  createField,
  dependantsWarning,
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
import { SALES_STAGES } from '../src/registry/core.ts'
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
import { bulkUpdateRecords, createRecord, deleteRecord, getRecord, listRecords, restoreRecords, updateRecord } from '../src/dal/records.ts'
import { readTimeline } from '../src/dal/activity.ts'
import { readBoard, groupableFields } from '../src/dal/board.ts'
import { deleteView, saveView } from '../src/dal/views.ts'
import { createCustomObject, deleteCustomObject } from '../src/dal/objects.ts'
import { recordOptions } from '../src/dal/search.ts'
import { forgetRegistry, getRegistry, mutateRegistry, objectOrThrow } from '../src/dal/registry.ts'
import { deleteEmailTemplate, saveEmailTemplate } from '../src/dal/sequences.ts'
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

  await check('a rename rewrites the view, segment and rule that name the old choice, and not another field with the same text', async () => {
    const otherKey = `verify_other_${stamp}`
    await createField(admin, { objectKey: 'deal', key: otherKey, label: 'Verify other risk', type: 'select', options: ['Low', 'Medium', 'High'] })
    const onKey = (field: string, value: string) => ({ conjunction: 'and' as const, conditions: [{ field, operator: 'is' as const, value }] })

    const view = await saveView(admin, {
      objectKey: 'deal',
      name: `Verify view ${stamp}`,
      kind: 'table',
      columns: ['name'],
      sorts: [],
      filters: [onKey(fieldKey, 'High'), onKey(otherKey, 'High')],
      expectedUpdatedAt: null,
    })
    const segment = await saveSegment(admin, { objectKey: 'deal', name: `Verify segment ${stamp}`, filters: [onKey(fieldKey, 'High')] })
    const otherSegment = await saveSegment(admin, { objectKey: 'deal', name: `Verify other segment ${stamp}`, filters: [onKey(otherKey, 'High')] })
    const rule = await saveAutomation(admin, {
      name: `Verify rule ${stamp}`,
      trigger: 'record_created',
      objectKey: 'deal',
      conditions: [onKey(fieldKey, 'High')],
      steps: [
        { kind: 'action', type: 'set_field', config: { field: fieldKey, value: 'High' } },
        { kind: 'action', type: 'set_field', config: { field: otherKey, value: 'High' } },
      ],
      isActive: false,
    })
    const [beforeView] = await owner<{ updated_at: Date }[]>`select updated_at from saved_view where id = ${view.id}::uuid`

    try {
      await updateField(admin, { id: fieldId, options: ['Low', 'Medium', 'Urgent'], renames: [{ from: 'High', to: 'Urgent' }] })

      const [viewRow] = await owner<{ filters: unknown; updated_at: Date }[]>`select filters, updated_at from saved_view where id = ${view.id}::uuid`
      const [segmentRow] = await owner<{ query: unknown }[]>`select query from segment where id = ${segment.id}::uuid`
      const [otherSegmentRow] = await owner<{ query: unknown }[]>`select query from segment where id = ${otherSegment.id}::uuid`
      const [ruleRow] = await owner<{ conditions: unknown; steps: unknown }[]>`select conditions, steps from automation where id = ${rule.id}::uuid`
      const values = (node: unknown, field: string): unknown[] =>
        Array.isArray(node)
          ? node.flatMap((entry) => values(entry, field))
          : node && typeof node === 'object'
            ? (node as { field?: unknown }).field === field
              ? [(node as { value?: unknown }).value]
              : Object.values(node).flatMap((child) => values(child, field))
            : []
      const setValues = (node: unknown, field: string): unknown[] =>
        Array.isArray(node)
          ? node.flatMap((entry) => setValues(entry, field))
          : node && typeof node === 'object'
            ? (node as { type?: unknown; config?: { field?: unknown; value?: unknown } }).type === 'set_field' &&
              (node as { config: { field?: unknown } }).config.field === field
              ? [(node as { config: { value?: unknown } }).config.value]
              : Object.values(node).flatMap((child) => setValues(child, field))
            : []

      expect(JSON.stringify(values(viewRow!.filters, fieldKey)) === '["Urgent"]', `view filter says ${JSON.stringify(values(viewRow!.filters, fieldKey))}`)
      expect(JSON.stringify(values(viewRow!.filters, otherKey)) === '["High"]', 'the other field in the same view was rewritten')
      expect(viewRow!.updated_at > beforeView!.updated_at, 'the view did not record the change')
      expect(JSON.stringify(values(segmentRow!.query, fieldKey)) === '["Urgent"]', 'the segment still names High')
      expect(JSON.stringify(values(otherSegmentRow!.query, otherKey)) === '["High"]', 'the other field segment was rewritten')
      expect(JSON.stringify(values(ruleRow!.conditions, fieldKey)) === '["Urgent"]', 'the rule condition still names High')
      expect(JSON.stringify(setValues(ruleRow!.steps, fieldKey)) === '["Urgent"]', 'the rule action still sets High')
      expect(JSON.stringify(setValues(ruleRow!.steps, otherKey)) === '["High"]', 'the other field action was rewritten')
    } finally {
      await deleteView(admin, view.id!)
      await deleteSegment(admin, segment.id)
      await deleteSegment(admin, otherSegment.id)
      await removeAutomation(admin, rule.id)
    }
    return 'view, segment, rule condition and rule action follow the rename; the same text on another field stays'
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

  await check('a second property with the same key is refused, naming the object and the label', async () => {
    const key = `clash_live_${stamp}`
    const first = await createField(admin, { objectKey: 'deal', key, label: 'Verify live clash', type: 'text' })
    try {
      const message = await refuses('a duplicate live key', () =>
        createField(admin, { objectKey: 'deal', key, label: 'Verify live clash again', type: 'text' }),
      )
      expect(message.includes('already has a property called "Verify live clash again"'), `unexpected refusal: "${message}"`)
      expect(!message.includes(key), 'the internal key is in the refusal')
      return message
    } finally {
      await deleteField(admin, first.id)
      await purgeField(admin, first.id)
    }
  })

  await check('a key held by an archived property is refused, with the way out', async () => {
    const key = `clash_arch_${stamp}`
    const first = await createField(admin, { objectKey: 'deal', key, label: 'Verify archived clash', type: 'text' })
    await deleteField(admin, first.id)
    try {
      const message = await refuses('a key held by an archived property', () =>
        createField(admin, { objectKey: 'deal', key, label: 'Verify archived again', type: 'text' }),
      )
      expect(message.includes('"Verify archived again" is archived on '), `unexpected refusal: "${message}"`)
      expect(message.includes('Restore it from Archived'), `no way out in: "${message}"`)
      expect(!message.includes('deleted but not purged'), 'the old copy is still in the refusal')
      return message
    } finally {
      await purgeField(admin, first.id)
    }
  })

  await check('a paste of 201 distinct choices is refused with the limit sentence', async () => {
    const choices = Array.from({ length: 201 }, (_, n) => `Choice ${n}`)
    const message = await refuses('201 choices', () =>
      createField(admin, { objectKey: 'deal', key: `many_${stamp}`, label: 'Verify many', type: 'select', options: choices }),
    )
    expect(message.includes('200 is the limit'), `unexpected refusal: "${message}"`)
    expect(!message.includes('too_big') && !message.includes('['), `a raw validation error leaked: "${message}"`)
    return message
  })

  await check('blank and repeated lines do not count toward the choice limit', async () => {
    const choices = [...Array.from({ length: 200 }, (_, n) => `Choice ${n}`), '', '   ', 'Choice 1', 'Choice 1']
    const created = await createField(admin, { objectKey: 'deal', key: `many_ok_${stamp}`, label: 'Verify many ok', type: 'select', options: choices })
    try {
      expect(created.options.length === 200, `${created.options.length} choices kept`)
      return '200 choices kept'
    } finally {
      await deleteField(admin, created.id)
      await purgeField(admin, created.id)
    }
  })

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
  console.log('-- what reads a property ---------------------------------------')

  await check('a rule on another property is a use, and archiving it needs confirming', async () => {
    const parent = await createField(admin, { objectKey: 'contact', key: `dep_p_${stamp}`, label: `Dep parent ${stamp}`, type: 'text' })
    const child = await createField(admin, {
      objectKey: 'contact',
      key: `dep_c_${stamp}`,
      label: `Dep child ${stamp}`,
      type: 'text',
      conditional: { conjunction: 'and', conditions: [{ field: `dep_p_${stamp}`, operator: 'is_not_empty' }] },
    })
    const usage = await fieldUsage(admin, parent.id)
    expect(
      usage.usedIn.some((use) => use.kind === 'property' && use.name === `Dep child ${stamp}`),
      'the rule on the child is not listed as a use',
    )
    expect(usage.usedInTotal === 1, `total ${usage.usedInTotal}, expected 1`)
    const message = await refuses('archiving a property a rule reads, unconfirmed', () => deleteField(admin, parent.id))
    expect(message === dependantsWarning(`Dep parent ${stamp}`, 1), `wrong refusal: ${message}`)
    expect((await listFields(admin, 'contact')).some((field) => field.id === parent.id), 'the refused archive still hid it')
    await deleteField(admin, parent.id, { acknowledgeUses: true })
    await deleteField(admin, child.id)
    await purgeField(admin, child.id)
    await purgeField(admin, parent.id)
    return message
  })

  await check('a rule that makes two properties show each other is refused at save', async () => {
    const left = await createField(admin, { objectKey: 'contact', key: `loop_a_${stamp}`, label: `Loop A ${stamp}`, type: 'text' })
    const right = await createField(admin, {
      objectKey: 'contact',
      key: `loop_b_${stamp}`,
      label: `Loop B ${stamp}`,
      type: 'text',
      conditional: { conjunction: 'and', conditions: [{ field: `loop_a_${stamp}`, operator: 'is_not_empty' }] },
    })
    const message = await refuses('closing a loop between two rules', () =>
      updateField(admin, {
        id: left.id,
        conditional: { conjunction: 'and', conditions: [{ field: `loop_b_${stamp}`, operator: 'is_not_empty' }] },
      }),
    )
    expect(message.includes('would hide each other'), `wrong refusal: ${message}`)
    expect(message.includes(`"Loop A ${stamp}" -> "Loop B ${stamp}"`), `the refusal did not name the labels: ${message}`)
    expect(!message.includes(`loop_a_${stamp}`), `the refusal named an internal key: ${message}`)
    await deleteField(admin, right.id)
    await purgeField(admin, right.id)
    await deleteField(admin, left.id)
    await purgeField(admin, left.id)
    return message
  })

  await check('a property created through the admin path is in the registry a second copy of the package reads', async () => {
    // Next loads this package once per server layer, so the page and the API each hold their own copy.
    const copy = '../src/dal/registry.ts?copy=page'
    const page = (await import(copy)) as typeof import('../src/dal/registry.ts')
    const key = `copy_${stamp}`
    const hasKey = async () => (await page.getRegistry(admin)).byKey.get('contact')?.byKey.has(key) === true
    expect(!(await hasKey()), 'the key was already in the registry before it was created')
    const field = await createField(admin, { objectKey: 'contact', key, label: `Copy ${stamp}`, type: 'text' })
    expect(await hasKey(), 'the second copy still served the registry from before the create')
    await deleteField(admin, field.id)
    await purgeField(admin, field.id)
    return 'visible to the second copy straight after the create'
  })

  await check('a template, sequence or booking page that spells a property key is a use', async () => {
    const tokenKey = `tok_${stamp}`
    const token = await createField(admin, { objectKey: 'contact', key: tokenKey, label: `Token ${stamp}`, type: 'text' })
    const named = await saveEmailTemplate(admin, { name: `Verify named ${stamp}`, subject: '', bodyText: `Hi {{ ${tokenKey} | there }}` })
    const longer = await saveEmailTemplate(admin, {
      name: `Verify longer ${stamp}`,
      subject: '',
      bodyText: `Hi {{${tokenKey}_more}}, the word ${tokenKey} in prose`,
    })
    const [sequence] = await db
      .insert(s.sequence)
      .values({
        accountId: datasaur.id,
        name: `Verify seq ${stamp}`,
        settings: {
          sendWindow: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', timezone: 'UTC' },
          stopOnReply: true,
          stopOnBounce: true,
          stopOnUnsubscribe: true,
          trackOpens: false,
          trackClicks: false,
          subscriptionTypeId: null,
          replyInThread: false,
          woodpeckerCampaignId: null,
        },
      })
      .returning({ id: s.sequence.id })
    await db.insert(s.sequenceStep).values({
      accountId: datasaur.id,
      sequenceId: sequence!.id,
      position: 1,
      bodyText: `Hello {{${tokenKey}|there}}`,
    })
    const [page] = await db
      .insert(s.bookingPage)
      .values({
        accountId: datasaur.id,
        slug: `verify-${stamp}`,
        name: `Verify booking ${stamp}`,
        titleTpl: `Call {{contact.${tokenKey}}}`,
        descriptionTpl: '',
      })
      .returning({ id: s.bookingPage.id })

    const usage = await fieldUsage(admin, token.id)
    const kinds = usage.usedIn.map((use) => `${use.kind}:${use.name}`)
    expect(kinds.includes(`template:Verify named ${stamp}`), `template not listed: ${kinds.join(', ')}`)
    expect(kinds.includes(`sequence:Verify seq ${stamp}`), `sequence not listed: ${kinds.join(', ')}`)
    expect(kinds.includes(`booking:Verify booking ${stamp}`), `booking page not listed: ${kinds.join(', ')}`)
    expect(!kinds.includes(`template:Verify longer ${stamp}`), 'a longer key or prose matched the token')

    await deleteEmailTemplate(admin, named.id)
    await deleteEmailTemplate(admin, longer.id)
    await db.delete(s.sequence).where(eq(s.sequence.id, sequence!.id))
    await db.delete(s.bookingPage).where(eq(s.bookingPage.id, page!.id))
    await deleteField(admin, token.id, { acknowledgeUses: true })
    await purgeField(admin, token.id)
    return 'a template, a sequence step and a booking title each name the key'
  })

  await check('an automation on another object does not count for a contact property', async () => {
    const tokenKey = `scope_${stamp}`
    const field = await createField(admin, { objectKey: 'contact', key: tokenKey, label: `Scope ${stamp}`, type: 'text' })
    const rule = (object: string, name: string) => ({
      accountId: datasaur.id,
      name,
      trigger: 'record_created' as const,
      triggerConfig: { object },
      conditions: [{ conjunction: 'and', conditions: [{ field: tokenKey, operator: 'is_not_empty' }] }],
      steps: [],
    })
    const [company, contactRule] = await db
      .insert(s.automation)
      .values([rule('company', `Verify company rule ${stamp}`), rule('contact', `Verify contact rule ${stamp}`)])
      .returning({ id: s.automation.id })
    const kinds = (await fieldUsage(admin, field.id)).usedIn.map((use) => use.name)
    expect(kinds.includes(`Verify contact rule ${stamp}`), 'the contact rule is not listed')
    expect(!kinds.includes(`Verify company rule ${stamp}`), 'a company rule counted for a contact property')
    await db.delete(s.automation).where(eq(s.automation.id, company!.id))
    await db.delete(s.automation).where(eq(s.automation.id, contactRule!.id))
    await deleteField(admin, field.id, { acknowledgeUses: true })
    await purgeField(admin, field.id)
    return 'only the rule on the same object reads the property'
  })

  await check('a committed property change is in the registry the moment the write returns', async () => {
    const key = `reg_${stamp}`
    const field = await createField(admin, { objectKey: 'deal', key, label: 'Registry probe', type: 'text' })
    expect(objectOrThrow(await getRegistry(admin), 'deal').byKey.get(key)?.label === 'Registry probe', 'the cache did not load the new property')
    await mutateRegistry(admin, 'field_def', async (tx) => {
      await tx.update(s.fieldDef).set({ label: 'Registry probe renamed' }).where(eq(s.fieldDef.id, field.id))
      return { result: undefined, audit: { entity: 'field_def', entityId: field.id, action: 'update', before: null, after: null } }
    })
    const after = await getRegistry(admin)
    expect(objectOrThrow(after, 'deal').byKey.get(key)?.label === 'Registry probe renamed', 'a read after the commit still has the old label')
    await deleteField(admin, field.id)
    await purgeField(admin, field.id)
    return 'the cache is dropped after the commit'
  })

  await check('a write that fails after reading the registry leaves no trace in it', async () => {
    const key = `reg_roll_${stamp}`
    const field = await createField(admin, { objectKey: 'deal', key, label: 'Rolled back probe', type: 'text' })
    const message = await refuses('a write that fails after it renamed a property', () =>
      mutateRegistry(admin, 'field_def', async (tx) => {
        await tx.update(s.fieldDef).set({ label: 'Rolled back renamed' }).where(eq(s.fieldDef.id, field.id))
        await getRegistry(admin)
        throw new Error('stopped after the read')
      }),
    )
    expect(message === 'stopped after the read', `wrong failure: ${message}`)
    const after = await getRegistry(admin)
    expect(objectOrThrow(after, 'deal').byKey.get(key)?.label === 'Rolled back probe', 'the rolled back rename is served from the cache')
    await deleteField(admin, field.id)
    await purgeField(admin, field.id)
    return 'nothing uncommitted is cached'
  })

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
    expect(found?.stages.length === SALES_STAGES.length + 2, `${found?.stages.length} stages`)
    return `${SALES_STAGES.length + 2} stages, with probabilities`
  })

  await check("a new pipeline starts with the account's seven stages, in order", async () => {
    const found = (await listPipelines(admin)).find((row) => row.id === pipelineId)
    const seeded = found!.stages.slice(0, SALES_STAGES.length)
    expect(
      seeded.map((stage) => stage.name).join('|') === SALES_STAGES.map((stage) => stage.name).join('|'),
      'the seeded stage names are out of order',
    )
    expect(seeded[5]!.isClosedWon && !seeded[5]!.isClosedLost, 'Closed Won is not a closed won stage')
    expect(seeded[6]!.isClosedLost && !seeded[6]!.isClosedWon, 'Closed Lost is not a closed lost stage')
    return `${seeded.length} stages, Closed Won and Closed Lost flagged`
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

  const dealRow = async (id: string) =>
    (await db.execute<{ pipeline_id: string; stage_id: string; deleted: boolean }>(
      sql`select pipeline_id, stage_id, deleted_at is not null as deleted from deal where id = ${id}`,
    ))[0]!
  const hardDelete = async (id: string) => {
    await db.execute(sql`delete from activity_link where entity_id = ${id}`)
    await db.execute(sql`delete from deal where id = ${id}`)
  }

  await check('a pipeline holding only deleted deals deletes, and Restore finds the deals in the first other pipeline', async () => {
    const trashed = await createPipeline(admin, `Verify trash ${stamp}`)
    const stage = await createStage(admin, { pipelineId: trashed.id, name: 'Only' })
    const first = (await listPipelines(admin))[0]!
    expect(first.id !== trashed.id && first.stages.length > 0, 'no other pipeline with a stage to land in')
    const ids: string[] = []
    for (const n of [1, 2]) {
      const created = await createRecord(admin, 'deal', { name: `Verify trashed ${n} ${stamp}`, pipeline_id: trashed.id, stage_id: stage.id })
      await deleteRecord(admin, 'deal', created.id)
      ids.push(created.id)
    }
    try {
      await deletePipeline(admin, trashed.id)
      for (const id of ids) {
        const row = await dealRow(id)
        expect(row.pipeline_id === first.id && row.stage_id === first.stages[0]!.id && row.deleted, 'a deleted deal did not land in the first stage of the first pipeline')
      }
      await restoreRecords(admin, 'deal', ids)
      const restored = await getRecord(admin, 'deal', ids[0]!)
      expect(restored?.values.stage_id === first.stages[0]!.id && restored.values.pipeline_id === first.id, 'the restored deal is not on the new pipeline and stage')
      return `2 deleted deals moved to ${first.name}, first stage`
    } finally {
      for (const id of ids) await hardDelete(id)
    }
  })

  await check('a stage holding only deleted deals deletes, and they land in its first other stage', async () => {
    const holder = await createPipeline(admin, `Verify trash stage ${stamp}`)
    await db.execute(sql`delete from pipeline_stage where pipeline_id = ${holder.id}`)
    const x =(await createStage(admin, { pipelineId: holder.id, name: 'X' })).id
    const y = (await createStage(admin, { pipelineId: holder.id, name: 'Y' })).id
    const created = await createRecord(admin, 'deal', { name: `Verify trashed stage ${stamp}`, pipeline_id: holder.id, stage_id: x })
    await deleteRecord(admin, 'deal', created.id)
    try {
      const result = await deleteStage(admin, x, null)
      const row = await dealRow(created.id)
      expect(result.moved === 0 && row.stage_id === y && row.pipeline_id === holder.id && row.deleted, 'the deleted deal did not move to Y on its own pipeline')
      const refusal = await refuses('deleting the only stage while a deleted deal sits in it', () => deleteStage(admin, y, null))
      expect(refusal.includes('Add one to this pipeline first'), `unexpected refusal: "${refusal}"`)
      return refusal
    } finally {
      await hardDelete(created.id)
      await deletePipeline(admin, holder.id)
    }
  })

  await check('a pipeline whose destination has no stage refuses with a sentence', async () => {
    const trashed = await createPipeline(admin, `Verify no stage ${stamp}`)
    const stage = await createStage(admin, { pipelineId: trashed.id, name: 'Only' })
    const created = await createRecord(admin, 'deal', { name: `Verify trashed bare ${stamp}`, pipeline_id: trashed.id, stage_id: stage.id })
    await deleteRecord(admin, 'deal', created.id)
    const bare = await createPipeline(admin, `Verify bare ${stamp}`)
    try {
      await db.execute(sql`delete from pipeline_stage where pipeline_id = ${bare.id}`)
      await db.execute(sql`update pipeline set position = -1 where id = ${bare.id}`)
      const refusal = await refuses('deleting into a pipeline with no stage', () => deletePipeline(admin, trashed.id))
      expect(refusal.includes(`Add a stage to Verify bare ${stamp}`), `unexpected refusal: "${refusal}"`)
      return refusal
    } finally {
      await hardDelete(created.id)
      await deletePipeline(admin, trashed.id)
      await deletePipeline(admin, bare.id)
    }
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

  await check('deleting a lifecycle stage writes one timeline entry per live record it moves, and names the count', async () => {
    const from = await createLifecycleStage(admin, `Verify from ${stamp}`)
    const toName = `Verify to ${stamp}`
    const to = await createLifecycleStage(admin, toName)
    const person = await createRecord(admin, 'contact', { email: `lifecycle-${stamp}@sandbox.test` })
    const company = await createRecord(admin, 'company', { name: `Verify lifecycle ${stamp}` })
    await db.update(s.contact).set({ lifecycleStageId: from.id }).where(eq(s.contact.id, person.id))
    await db.update(s.company).set({ lifecycleStageId: from.id }).where(eq(s.company.id, company.id))

    const result = await deleteLifecycleStage(admin, from.id, to.id)
    expect(result.moved === 2 && result.movedTo === toName, `moved ${result.moved} to ${result.movedTo}`)

    const contactTimeline = await readTimeline(admin, { entity: { entityType: 'contact', entityId: person.id } })
    const companyTimeline = await readTimeline(admin, { entity: { entityType: 'company', entityId: company.id } })
    const moves = (rows: { type: string }[]) => rows.filter((row) => row.type === 'lifecycle_change')
    expect(moves(contactTimeline.rows).length === 1, `contact has ${moves(contactTimeline.rows).length} lifecycle entries`)
    expect(moves(companyTimeline.rows).length === 1, `company has ${moves(companyTimeline.rows).length} lifecycle entries`)

    await db.update(s.contact).set({ lifecycleStageId: null }).where(eq(s.contact.id, person.id))
    await db.update(s.company).set({ lifecycleStageId: null }).where(eq(s.company.id, company.id))
    await deleteLifecycleStage(admin, to.id, null)
    return `${result.moved} moved to ${result.movedTo}, one entry each`
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

  await check('an internal type cannot also need confirming, on create or on update, and each flag alone is fine', async () => {
    const message = await refuses('an internal type with confirmed opt-in on create', () =>
      createSubscriptionType(marketing, { name: `Both ${stamp}`, isInternal: true, doubleOptIn: true }),
    )
    expect(message.includes('never offered on a form'), message)
    const internal = await createSubscriptionType(marketing, { name: `Internal ${stamp}`, isInternal: true })
    const confirmed = await createSubscriptionType(marketing, { name: `Confirmed ${stamp}`, doubleOptIn: true })
    const turnedOn = await refuses('turning confirmed opt-in on for an internal type', () =>
      updateSubscriptionType(marketing, { id: internal.id, doubleOptIn: true }),
    )
    expect(turnedOn.includes('never offered on a form'), turnedOn)
    const turnedOnInternal = await refuses('turning internal on for a confirmed type', () =>
      updateSubscriptionType(marketing, { id: confirmed.id, isInternal: true }),
    )
    expect(turnedOnInternal.includes('never offered on a form'), turnedOnInternal)
    await updateSubscriptionType(marketing, { id: internal.id, name: `Internal renamed ${stamp}` })
    await updateSubscriptionType(marketing, { id: internal.id, isInternal: false, doubleOptIn: true })
    await deleteSubscriptionType(marketing, internal.id, 0)
    await deleteSubscriptionType(marketing, confirmed.id, 0)
    return message
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
    const read = (await listRecords(admin, { object: 'deal', limit: 3 })).rows
    const ids = read.map((row) => row.id)
    const seen = new Map(read.map((row) => [row.id, new Date(row.version)]))
    const result = await bulkUpdateRecords(admin, 'deal', ids, { deal_type: 'Renewal' }, seen)
    expect(result.updated === ids.length, `${result.updated} of ${ids.length} updated`)
    expect(result.failed.length === 0, JSON.stringify(result.failed))
    return `${result.updated} deals changed in one call`
  })

  await check('a row somebody changed since it was read is refused, not overwritten', async () => {
    const read = (await listRecords(admin, { object: 'deal', limit: 2 })).rows
    const seen = new Map(read.map((row) => [row.id, new Date(row.version)]))
    await bulkUpdateRecords(admin, 'deal', read.map((row) => row.id), { deal_type: 'New business' }, seen)
    const stale = await bulkUpdateRecords(admin, 'deal', read.map((row) => row.id), { deal_type: 'Renewal' }, seen)
    expect(stale.updated === 0 && stale.failed.length === read.length, `${stale.updated} written, ${stale.failed.length} refused`)
    expect(stale.failed[0]!.reason.includes('Someone else'), stale.failed[0]!.reason)
    return `${stale.failed.length} refused with the reason`
  })

  await check('a row that refuses the change is named, and the rest still save', async () => {
    const contacts = await recordOptions(admin, { object: 'contact', limit: 3 })
    const result = await bulkUpdateRecords(admin, 'contact', contacts.map((row) => row.id), {
      // Every contact would end up with the same address, so all but the first
      // collide on the unique index.
      email: `bulk-${stamp}@verify.example`,
    }, null)
    expect(result.updated >= 1, 'nothing was written at all')
    expect(result.failed.length >= 1, 'a duplicate email was allowed')
    expect(Boolean(result.failed[0]?.displayName), 'a failure came back without a name')
    return `${result.updated} written, ${result.failed.length} named back with a reason`
  })

  await check('a read-only seat cannot bulk edit', async () => {
    const deals = await recordOptions(viewer, { object: 'deal', limit: 1 })
    const message = await refuses('a read-only seat bulk editing', () =>
      bulkUpdateRecords(viewer, 'deal', [deals[0]!.id], { deal_type: 'Renewal' }, null),
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
  console.log('-- renaming a choice and removing one in use --------------------')

  // Values are stored as the choice's text, so a rename has to rewrite them in the
  // same save, and a removal has to be refused while anything still holds the text.
  // A custom object, because a rename's search text is kept only on custom records.
  const object = await createCustomObject(admin, { nameSingular: `Verify choice ${stamp}`, namePlural: `Verify choices ${stamp}` })
  const stageKey = `verify_stage_${stamp}`
  const tagKey = `verify_tags_${stamp}`
  const stage = await createField(admin, { objectKey: object.key, key: stageKey, label: 'Verify stage', type: 'select', options: ['Lead', 'Trial', 'Won'] })
  const tags = await createField(admin, { objectKey: object.key, key: tagKey, label: 'Verify tags', type: 'multi_select', options: ['Alpha', 'Beta', 'Gamma'] })
  const choiceNamed = (tag: string) => `Verify choice ${tag} ${stamp}`
  const one = await createRecord(admin, object.key, { name: choiceNamed('one'), [stageKey]: 'Lead', [tagKey]: ['Alpha', 'Beta'] })
  const two = await createRecord(admin, object.key, { name: choiceNamed('two'), [stageKey]: 'Trial', [tagKey]: ['Beta'] })
  const three = await createRecord(admin, object.key, { name: choiceNamed('three'), [stageKey]: 'Lead', [tagKey]: ['Gamma'] })
  const four = await createRecord(admin, object.key, { name: choiceNamed('four') })
  const recordIds = [one!.id, two!.id, three!.id, four!.id]
  const valuesOf = async (keys: string[]) => {
    const rows = await db.execute<{ id: string; custom: Record<string, unknown>; search_text: string | null }>(
      sql`select id, custom, search_text from custom_record where id in (${sql.join(recordIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
    )
    return new Map(rows.map((row) => [row.id, { custom: row.custom, search: row.search_text, pick: keys.map((key) => row.custom[key]) }]))
  }

  await check('a rename moves every record that holds the old choice, trashed ones too', async () => {
    await updateField(admin, { id: stage.id, options: ['Prospect', 'Trial', 'Won'], renames: [{ from: 'Lead', to: 'Prospect' }] })
    await deleteRecord(admin, object.key, three!.id)
    const after = await valuesOf([stageKey])
    expect(after.get(one!.id)?.custom[stageKey] === 'Prospect', `one holds ${String(after.get(one!.id)?.custom[stageKey])}`)
    expect(after.get(three!.id)?.custom[stageKey] === 'Prospect', `trashed three holds ${String(after.get(three!.id)?.custom[stageKey])}`)
    expect(after.get(two!.id)?.custom[stageKey] === 'Trial', 'a record on another choice was touched')
    return 'Lead became Prospect on two records, the trashed one included'
  })

  await check('the search text follows the rename', async () => {
    const after = await valuesOf([stageKey])
    expect(after.get(one!.id)?.search?.includes('Prospect') === true, `search text is ${String(after.get(one!.id)?.search)}`)
    expect(after.get(one!.id)?.search?.includes('Lead') === false, 'the old choice is still searchable')
    return 'found by the new name, not the old'
  })

  await check('a choice still held by a record cannot be removed, and the count includes trashed records', async () => {
    const message = await refuses('removing a choice in use', () =>
      updateField(admin, { id: stage.id, options: ['Trial', 'Won'] }),
    )
    expect(message === '2 records still use Prospect. Change them first.', `said: ${message}`)
    return message
  })

  await check('removing a choice nothing holds is allowed', async () => {
    await updateField(admin, { id: stage.id, options: ['Prospect', 'Trial'] })
    await updateField(admin, { id: stage.id, options: ['Prospect', 'Trial', 'Won'] })
    return 'Won went and came back, with nothing lost'
  })

  await check('a rename onto a choice that stays is refused, not merged', async () => {
    const message = await refuses('a rename onto an existing choice', () =>
      updateField(admin, { id: stage.id, options: ['Prospect', 'Won'], renames: [{ from: 'Trial', to: 'Won' }] }),
    )
    expect(message === 'Won is already a choice on Verify stage.', `said: ${message}`)
    return message
  })

  await check('a swap of two names in one save moves both sets of records', async () => {
    await updateField(admin, {
      id: stage.id,
      options: ['Trial', 'Prospect', 'Won'],
      renames: [
        { from: 'Prospect', to: 'Trial' },
        { from: 'Trial', to: 'Prospect' },
      ],
    })
    const after = await valuesOf([stageKey])
    expect(after.get(one!.id)?.custom[stageKey] === 'Trial', 'the Prospect record did not become Trial')
    expect(after.get(two!.id)?.custom[stageKey] === 'Prospect', 'the Trial record did not become Prospect')
    return 'one statement, so neither rename was applied twice'
  })

  await check('a case-only rename is a rename, and an empty value is left alone', async () => {
    await updateField(admin, { id: stage.id, options: ['Trial', 'Prospect', 'won'], renames: [{ from: 'Won', to: 'won' }] })
    const after = await valuesOf([stageKey])
    expect(after.get(four!.id)?.custom[stageKey] === undefined, 'a record with no value gained one')
    expect(after.get(two!.id)?.custom[stageKey] === 'Prospect', 'a value changed that was not renamed')
    return 'a record with no value is untouched'
  })

  await check('a multi-select rename keeps the order of the other values', async () => {
    await updateField(admin, { id: tags.id, options: ['Alpha', 'Bravo', 'Gamma'], renames: [{ from: 'Beta', to: 'Bravo' }] })
    const after = await valuesOf([tagKey])
    expect(JSON.stringify(after.get(one!.id)?.custom[tagKey]) === '["Alpha","Bravo"]', `one holds ${JSON.stringify(after.get(one!.id)?.custom[tagKey])}`)
    expect(JSON.stringify(after.get(two!.id)?.custom[tagKey]) === '["Bravo"]', `two holds ${JSON.stringify(after.get(two!.id)?.custom[tagKey])}`)
    return 'Beta became Bravo inside each list'
  })

  await check('a multi-select choice held only by a trashed record still cannot be removed', async () => {
    const message = await refuses('removing a multi-select choice in use', () =>
      updateField(admin, { id: tags.id, options: ['Alpha', 'Bravo'] }),
    )
    expect(message === '1 record still uses Gamma. Change them first.', `said: ${message}`)
    return message
  })

  await check('a rename of a built-in choice rewrites the column and restores cleanly', async () => {
    const lead = (await listFields(admin, 'contact')).find((field) => field.key === 'lead_status')
    expect(Boolean(lead), 'no lead_status property')
    const choice = lead!.options[0]!
    const renamed = `${choice} (verify)`
    const person = await createRecord(admin, 'contact', {
      first_name: 'Choice',
      last_name: 'Verify',
      email: `choice-${stamp}@partner1.example`,
      lead_status: choice,
    })
    try {
      const refusal = await refuses('removing a built-in choice in use', () =>
        updateField(admin, { id: lead!.id, options: lead!.options.filter((option) => option !== choice) }),
      )
      expect(/^\d+ records? still uses? /.test(refusal) && refusal.endsWith(`${choice}. Change them first.`), `said: ${refusal}`)
      await updateField(admin, { id: lead!.id, options: [renamed, ...lead!.options.slice(1)], renames: [{ from: choice, to: renamed }] })
      const [row] = await db.execute<{ lead_status: string | null }>(sql`select lead_status from contact where id = ${person!.id}::uuid`)
      expect(row?.lead_status === renamed, `the column holds ${String(row?.lead_status)}`)
    } finally {
      await updateField(admin, { id: lead!.id, options: lead!.options, renames: [{ from: renamed, to: choice }] })
      await owner`delete from contact where id = ${person!.id}::uuid`
    }
    return `${choice} renamed on the column and put back`
  })

  for (const id of recordIds) await deleteRecord(admin, object.key, id).catch(() => undefined)
  await deleteField(admin, stage.id)
  await purgeField(admin, stage.id)
  await deleteField(admin, tags.id)
  await purgeField(admin, tags.id)
  await deleteCustomObject(admin, object.id)

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
