import { eq } from 'drizzle-orm'
import { CORE_OBJECTS, CORE_VIEWS, ENTERPRISE_STAGES, LIFECYCLE_STAGES, SALES_STAGES } from '../registry/core.ts'
import { savedView, subscriptionType } from '../schema/marketing.ts'
import { fieldDef, objectDef } from '../schema/metadata.ts'
import { lifecycleStage, pipeline, pipelineStage } from '../schema/records.ts'
import type { Tx } from './index.ts'

/** What a workspace needs before anybody can use it: the object and field
 *  definitions, the views every deep link falls back to, the lifecycle ladder, the
 *  subscription types and two pipelines.
 *
 *  One function so the seed and the "create a workspace" button provision the same
 *  thing. They used to be the same code copied once, which is how a new workspace
 *  ends up without the `all` view that every address falls back to. */
export const provisionWorkspace = async (tx: Tx, workspaceId: string): Promise<void> => {
  await tx
    .insert(lifecycleStage)
    .values(LIFECYCLE_STAGES.map((name, index) => ({ workspaceId, name, position: index })))

  await tx.insert(subscriptionType).values([
    { workspaceId, name: 'Product updates', description: 'Release notes and changelog.' },
    { workspaceId, name: 'Newsletter', description: 'The monthly newsletter.' },
    { workspaceId, name: 'One-to-one sales email', description: 'Direct email from a rep.' },
    { workspaceId, name: 'Internal notifications', isInternal: true },
  ])

  for (const object of CORE_OBJECTS) {
    const [created] = await tx
      .insert(objectDef)
      .values({
        workspaceId,
        key: object.key,
        nameSingular: object.nameSingular,
        namePlural: object.namePlural,
        icon: object.icon,
        isCustom: false,
      })
      .returning({ id: objectDef.id })
    if (!created) throw new Error(`object_def ${object.key} was not created`)

    const fields = await tx
      .insert(fieldDef)
      .values(
        object.fields.map((field) => ({
          workspaceId,
          objectId: created.id,
          key: field.key,
          label: field.label,
          type: field.type,
          // No column means the field lives in custom jsonb, which is how a
          // HubSpot custom property arrives.
          storage: field.columnName ? ('column' as const) : ('jsonb' as const),
          columnName: field.columnName ?? null,
          isCustom: !field.columnName,
          isRequired: field.isRequired ?? false,
          trackChanges: field.trackChanges ?? false,
          options: field.options ?? null,
          position: field.position,
        })),
      )
      .returning({ id: fieldDef.id, key: fieldDef.key })

    const labelField = fields.find((field) => field.key === object.labelFieldKey)
    if (labelField) {
      await tx.update(objectDef).set({ labelFieldId: labelField.id }).where(eq(objectDef.id, created.id))
    }

    // 'all' is the slug every deep link falls back to, so it is provisioned, not
    // created on demand.
    await tx.insert(savedView).values(
      CORE_VIEWS[object.key].map((view) => ({
        workspaceId,
        objectId: created.id,
        slug: view.slug,
        name: view.name,
        kind: view.kind,
        columns: view.columns,
        filters: view.filters ?? [],
        sorts: view.sorts ?? [],
        isShared: true,
        pinned: true,
        position: view.position,
        groupByFieldId: view.groupBy ? (fields.find((field) => field.key === view.groupBy)?.id ?? null) : null,
      })),
    )
  }

  const pipelines = await tx
    .insert(pipeline)
    .values([
      { workspaceId, name: 'Enterprise', position: 0 },
      { workspaceId, name: 'Sales Pipeline', position: 1 },
    ])
    .returning({ id: pipeline.id, name: pipeline.name })

  const enterprise = pipelines.find((row) => row.name === 'Enterprise')
  const sales = pipelines.find((row) => row.name === 'Sales Pipeline')
  if (!enterprise || !sales) throw new Error('the pipelines were not created')

  await tx.insert(pipelineStage).values([
    ...ENTERPRISE_STAGES.map((stage, index) => ({
      workspaceId,
      pipelineId: enterprise.id,
      name: stage.name,
      probability: stage.probability,
      position: index,
      isClosedWon: 'isClosedWon' in stage,
      isClosedLost: 'isClosedLost' in stage,
    })),
    ...SALES_STAGES.map((stage, index) => ({
      workspaceId,
      pipelineId: sales.id,
      name: stage.name,
      probability: stage.probability,
      position: index,
      isClosedWon: 'isClosedWon' in stage,
      isClosedLost: 'isClosedLost' in stage,
    })),
  ])
}
