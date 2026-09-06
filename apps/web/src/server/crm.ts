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

/** Relations small enough to enumerate. Users, pipelines, stages and lifecycle
 *  stages are workspace configuration and are counted in tens, so a select element
 *  is right. Companies are records, counted in tens of thousands, so they are
 *  searched instead: see PICK_OBJECT below. */
const choicesFor = (field: RegistryField, lookups: Lookups): Choice[] | undefined => {
  if (field.key === 'owner_id') return lookups.users
  if (field.key === 'pipeline_id') return lookups.pipelines
  if (field.key === 'stage_id') return lookups.stages.map(({ id, label }) => ({ id, label }))
  if (field.key === 'lifecycle_stage_id') return lookups.lifecycleStages
  return undefined
}

/** Relation fields whose target is an object rather than a configuration list.
 *  These render as a search box that asks the server, because no list element may
 *  ever try to hold 34,648 companies. */
const PICK_OBJECT: Partial<Record<string, ObjectKey>> = { company_id: 'company' }

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
  // Wider than a paragraph: a formatted note is written to be read, and a
  // column that cuts it at the first line is a column showing nothing.
  rich_text: 320,
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

/** Read-only fields are shown but never offered as an input, so nobody types into
 *  a source container the capture surfaces own or a create date the database keeps.
 *  Read-only is either a property of the type (json) or of the field itself
 *  (isSystem); both land on the same flag so the panel has one thing to check. */
export const toEditableFields = (
  object: RegistryObject,
  lookups: Lookups,
  { includeReadOnly = false } = {},
): EditableField[] =>
  object.fields
    .filter((field) => includeReadOnly || !isReadOnly(field))
    .map((field) => {
      const choices = choicesFor(field, lookups)
      const pickObject = PICK_OBJECT[field.key]
      return {
        key: field.key,
        label: field.label,
        type: field.type,
        isRequired: field.isRequired,
        helpText: field.helpText,
        options: field.options,
        readOnly: isReadOnly(field),
        ...(choices ? { choices } : {}),
        ...(pickObject ? { pickObject } : {}),
      }
    })

const isReadOnly = (field: RegistryField): boolean =>
  field.isSystem || TYPE_META[field.type].readOnly === true

export type CrmContext = {
  object: RegistryObject
  lookups: Lookups
  canWrite: boolean
  /** Every object in the workspace, for the switcher beside an index page's title. */
  objects: RegistryObject[]
}

export const loadCrmContext = async (ctx: WorkspaceContext, objectKey: string): Promise<CrmContext> => {
  const [registry, lookups] = await Promise.all([getRegistry(ctx), readLookups(ctx)])
  const object = registry.byKey.get(objectKey)
  if (!object) throw new Error(`This workspace has no object called "${objectKey}".`)
  // A custom object has no write role of its own. Whoever may write a record may
  // write one of its records: the three roles that can change a contact. An admin
  // still decides what objects exist at all, which is the object_def role.
  const entity = object.isCustom ? 'contact' : objectKey
  return { object, lookups, canWrite: canWrite(ctx.role, entity), objects: registry.objects }
}
