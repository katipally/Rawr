import { and, asc, eq, or, isNull } from 'drizzle-orm'
import { fieldDef } from '../schema/metadata.ts'
import { savedView } from '../schema/marketing.ts'
import { CORE_VIEWS, type ObjectKey } from '../registry/core.ts'
import type { WorkspaceContext } from './context.ts'
import { mutate, withWorkspace } from './index.ts'
import { parseFilters, parseSorts, type FilterGroup, type Sort } from './query.ts'
import { getRegistry, objectOrThrow } from './registry.ts'

export type ViewDefinition = {
  id: string | null
  slug: string
  name: string
  kind: 'table' | 'board'
  columns: string[]
  filters: FilterGroup[]
  sorts: Sort[]
  isShared: boolean
  ownerId: string | null
  position: number
  /** Board views only: the field whose values become columns. Null means stage. */
  groupByKey: string | null
}

/** Reserved: /objects/:object/views/all/list must always resolve, even in a
 *  workspace where every saved view has been deleted. */
export const DEFAULT_VIEW_SLUG = 'all'

const fallbackView = (objectKey: ObjectKey, slug: string): ViewDefinition => {
  const seeded = CORE_VIEWS[objectKey].find((view) => view.slug === slug) ?? CORE_VIEWS[objectKey][0]
  return {
    id: null,
    slug: seeded?.slug ?? DEFAULT_VIEW_SLUG,
    name: seeded?.name ?? 'All records',
    kind: seeded?.kind ?? 'table',
    columns: seeded?.columns ?? [],
    filters: parseFilters(seeded?.filters ?? []),
    sorts: parseSorts(seeded?.sorts ?? []),
    isShared: true,
    ownerId: null,
    position: seeded?.position ?? 0,
    groupByKey: seeded?.groupBy ?? null,
  }
}

const toDefinition = (row: {
  id: string
  slug: string
  name: string
  kind: 'table' | 'board'
  columns: unknown
  filters: unknown
  sorts: unknown
  isShared: boolean
  ownerId: string | null
  position: number
  /** Board views only: the field whose values become columns. Null means stage. */
  groupByKey: string | null
}): ViewDefinition => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  kind: row.kind,
  columns: Array.isArray(row.columns) ? (row.columns as string[]) : [],
  filters: parseFilters(row.filters),
  sorts: parseSorts(row.sorts),
  isShared: row.isShared,
  ownerId: row.ownerId,
  position: row.position,
  groupByKey: row.groupByKey,
})

/** The view tabs a person can see: the shared ones plus their own. */
export const listViews = async (
  ctx: WorkspaceContext,
  objectKey: string,
): Promise<ViewDefinition[]> => {
  const registry = await getRegistry(ctx)
  const object = objectOrThrow(registry, objectKey)

  const rows = await withWorkspace(ctx, (tx) =>
    tx
      .select({
        id: savedView.id,
        slug: savedView.slug,
        name: savedView.name,
        kind: savedView.kind,
        columns: savedView.columns,
        filters: savedView.filters,
        sorts: savedView.sorts,
        isShared: savedView.isShared,
        ownerId: savedView.ownerId,
        position: savedView.position,
        groupByKey: fieldDef.key,
      })
      .from(savedView)
      .leftJoin(fieldDef, eq(fieldDef.id, savedView.groupByFieldId))
      .where(
        and(
          eq(savedView.objectId, object.id),
          ctx.actorId
            ? or(eq(savedView.isShared, true), eq(savedView.ownerId, ctx.actorId), isNull(savedView.ownerId))
            : eq(savedView.isShared, true),
        ),
      )
      .orderBy(asc(savedView.position), asc(savedView.name)),
  )

  const views = rows.map(toDefinition)
  return views.length > 0 ? views : [fallbackView(object.key, DEFAULT_VIEW_SLUG)]
}

/** Resolves the slug in the URL. An unknown slug falls back to the default rather
 *  than 404ing, because a stale bookmark should still show the person their data. */
export const resolveView = async (
  ctx: WorkspaceContext,
  objectKey: string,
  slug: string,
): Promise<{ view: ViewDefinition; matched: boolean }> => {
  const views = await listViews(ctx, objectKey)
  const found = views.find((view) => view.slug === slug)
  if (found) return { view: found, matched: true }
  const fallback = views.find((view) => view.slug === DEFAULT_VIEW_SLUG) ?? views[0]
  const registry = await getRegistry(ctx)
  const object = objectOrThrow(registry, objectKey)
  return { view: fallback ?? fallbackView(object.key, DEFAULT_VIEW_SLUG), matched: false }
}

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'view'

export type SaveViewInput = {
  objectKey: string
  id?: string | null
  name: string
  kind: 'table' | 'board'
  columns: string[]
  filters: FilterGroup[]
  sorts: Sort[]
  isShared: boolean
}

export const saveView = async (
  ctx: WorkspaceContext,
  input: SaveViewInput,
): Promise<ViewDefinition> =>
  mutate(ctx, 'saved_view', async (tx) => {
    const registry = await getRegistry(ctx)
    const object = objectOrThrow(registry, input.objectKey)
    const unknown = input.columns.filter((key) => !object.byKey.has(key))
    if (unknown.length > 0) {
      throw new Error(`${object.namePlural} has no field called ${unknown.join(', ')}.`)
    }

    const base = slugify(input.name)
    const values = {
      workspaceId: ctx.workspaceId,
      objectId: object.id,
      name: input.name.trim(),
      kind: input.kind,
      columns: input.columns,
      filters: input.filters,
      sorts: input.sorts,
      isShared: input.isShared,
      ownerId: ctx.actorId,
    }

    if (input.id) {
      const [updated] = await tx
        .update(savedView)
        .set(values)
        .where(eq(savedView.id, input.id))
        .returning()
      if (!updated) throw new Error('That view no longer exists.')
      return {
        result: toDefinition(updated as never),
        audit: { entity: 'saved_view', entityId: updated.id, action: 'update', before: null, after: values },
      }
    }

    // A slug collision is a name collision, and a person renaming a view expects
    // the address to follow the name, so the suffix is only added when it must be.
    const taken = new Set(
      (await tx
        .select({ slug: savedView.slug })
        .from(savedView)
        .where(eq(savedView.objectId, object.id))).map((row) => row.slug),
    )
    taken.add(DEFAULT_VIEW_SLUG)
    let slug = base
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`

    const [created] = await tx
      .insert(savedView)
      .values({ ...values, slug, position: taken.size })
      .returning()
    if (!created) throw new Error('The view could not be saved.')

    return {
      result: toDefinition(created as never),
      audit: { entity: 'saved_view', entityId: created.id, action: 'create', before: null, after: { ...values, slug } },
    }
  })

export const deleteView = async (ctx: WorkspaceContext, id: string): Promise<void> =>
  mutate(ctx, 'saved_view', async (tx) => {
    const [row] = await tx.select({ slug: savedView.slug, name: savedView.name }).from(savedView).where(eq(savedView.id, id))
    if (!row) throw new Error('That view has already been deleted.')
    if (row.slug === DEFAULT_VIEW_SLUG) {
      throw new Error('The default view is the address every link falls back to, so it cannot be deleted.')
    }
    await tx.delete(savedView).where(eq(savedView.id, id))
    return {
      result: undefined,
      audit: { entity: 'saved_view', entityId: id, action: 'delete', before: row, after: null },
    }
  })
