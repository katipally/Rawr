import {
  TYPE_META,
  canWrite,
  getRegistry,
  schema,
  withWorkspace,
  type ObjectKey,
  type RegistryField,
  type RegistryObject,
  type WorkspaceContext,
} from '@rawr/db'
import { asc, eq } from 'drizzle-orm'
import type { EditableField } from '~/components/crm/field-input.tsx'
import type { FilterField } from '~/components/crm/filter-builder.tsx'
import type { TableColumn } from '~/components/crm/record-table.tsx'

/** Turns the registry into the shapes the surfaces render. Every list, board and
 *  record page goes through here, so none of them can invent a column the registry
 *  does not know about. */

export type Choice = { id: string; label: string }

export type Lookups = {
  users: Choice[]
  pipelines: Choice[]
  stages: { id: string; label: string; pipelineId: string }[]
  lifecycleStages: Choice[]
}

export const readLookups = async (ctx: WorkspaceContext): Promise<Lookups> =>
  withWorkspace(ctx, async (tx) => {
    const [users, pipelines, stages, lifecycles] = await Promise.all([
      tx
        .select({ id: schema.userAccount.id, name: schema.userAccount.name })
        .from(schema.membership)
        .innerJoin(schema.userAccount, eq(schema.userAccount.id, schema.membership.userId))
        .orderBy(asc(schema.userAccount.name)),
      tx.select({ id: schema.pipeline.id, name: schema.pipeline.name }).from(schema.pipeline).orderBy(asc(schema.pipeline.position)),
      tx
        .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name, pipelineId: schema.pipelineStage.pipelineId })
        .from(schema.pipelineStage)
        .orderBy(asc(schema.pipelineStage.position)),
      tx
        .select({ id: schema.lifecycleStage.id, name: schema.lifecycleStage.name })
        .from(schema.lifecycleStage)
        .orderBy(asc(schema.lifecycleStage.position)),
    ])

    return {
      users: users.map((user) => ({ id: user.id, label: user.name })),
      pipelines: pipelines.map((pipeline) => ({ id: pipeline.id, label: pipeline.name })),
      stages: stages.map((stage) => ({ id: stage.id, label: stage.name, pipelineId: stage.pipelineId })),
      lifecycleStages: lifecycles.map((stage) => ({ id: stage.id, label: stage.name })),
    }
  })

/** Companies are the one relation with too many rows for a fixed list, so the
 *  picker offers the most recent and the command palette covers the rest. */
const companyChoices = async (ctx: WorkspaceContext): Promise<Choice[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx
      .select({ id: schema.company.id, name: schema.company.name, domain: schema.company.domain })
      .from(schema.company)
      .orderBy(asc(schema.company.name))
      .limit(500)
    return rows.map((row) => ({ id: row.id, label: row.name ?? row.domain ?? 'Unnamed company' }))
  })

const choicesFor = (field: RegistryField, lookups: Lookups, companies: Choice[]): Choice[] | undefined => {
  if (field.key === 'owner_id') return lookups.users
  if (field.key === 'pipeline_id') return lookups.pipelines
  if (field.key === 'stage_id') return lookups.stages.map(({ id, label }) => ({ id, label }))
  if (field.key === 'lifecycle_stage_id') return lookups.lifecycleStages
  if (field.key === 'company_id') return companies
  return undefined
}

/** Starting widths by type. Without them the browser hands a long email column a
 *  few pixels and wraps it one character per line, which is what a table of
 *  addresses and 500-character names does by default. Every column stays
 *  resizable, so this is a starting point, not a lock. */
const WIDTHS: Partial<Record<string, number>> = {
  email: 240,
  url: 200,
  linkedin: 200,
  phone: 160,
  date: 130,
  datetime: 180,
  currency: 130,
  number: 120,
  percent: 110,
  boolean: 100,
  select: 160,
  multi_select: 200,
  relation: 200,
  user: 170,
  long_text: 280,
  json: 220,
}

export const toTableColumns = (object: RegistryObject, keys: string[]): TableColumn[] =>
  keys.flatMap((key) => {
    const field = object.byKey.get(key)
    if (!field) return []
    return [
      {
        key: field.key,
        label: field.label,
        type: field.type,
        numeric: TYPE_META[field.type].numeric === true,
        width: WIDTHS[field.type] ?? 180,
      },
    ]
  })

export const toFilterFields = (object: RegistryObject): FilterField[] =>
  object.fields.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    options: field.options,
    operators: field.operators,
  }))

/** Read-only types are shown but never offered as an input, so nobody types into
 *  a source container the capture surfaces own. */
export const toEditableFields = (
  object: RegistryObject,
  lookups: Lookups,
  companies: Choice[],
  { includeReadOnly = false } = {},
): EditableField[] =>
  object.fields
    .filter((field) => field.key !== 'created_at')
    .filter((field) => includeReadOnly || !TYPE_META[field.type].readOnly)
    .map((field) => {
      const choices = choicesFor(field, lookups, companies)
      return {
        key: field.key,
        label: field.label,
        type: field.type,
        isRequired: field.isRequired,
        helpText: field.helpText,
        options: field.options,
        readOnly: TYPE_META[field.type].readOnly === true,
        ...(choices ? { choices } : {}),
      }
    })

export type CrmContext = {
  object: RegistryObject
  lookups: Lookups
  companies: Choice[]
  canWrite: boolean
}

export const loadCrmContext = async (ctx: WorkspaceContext, objectKey: ObjectKey): Promise<CrmContext> => {
  const [registry, lookups, companies] = await Promise.all([
    getRegistry(ctx),
    readLookups(ctx),
    companyChoices(ctx),
  ])
  const object = registry.byKey.get(objectKey)
  if (!object) throw new Error(`This workspace has no object called "${objectKey}".`)
  return { object, lookups, companies, canWrite: canWrite(ctx.role, objectKey) }
}
