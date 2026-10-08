import { and, asc, desc, eq, inArray, or, isNull, sql } from 'drizzle-orm'
import { savedView } from '../schema/marketing.ts'
import { CORE_VIEWS } from '../registry/core.ts'
import { groupableField } from './board.ts'
import { placeableField } from './calendar.ts'
import { isAdmin, type AccountContext } from './context.ts'
import { mutate, withAccount } from './index.ts'
import { parseFilters, parseSorts, type FilterGroup, type Sort } from './query.ts'
import { ConflictError } from './records.ts'
import { getRegistry, objectOrThrow, type RegistryField, type RegistryObject } from './registry.ts'

export type ViewDefinition = {
  id: string | null
  slug: string
  name: string
  kind: 'table' | 'board' | 'calendar'
  columns: string[]
  filters: FilterGroup[]
  sorts: Sort[]
  isShared: boolean
  ownerId: string | null
  position: number
  /** A tab above the list. Unpinned views are still addressable and still listed,
   *  they just live behind "All views" instead of taking a tab. */
  pinned: boolean
  /** Board views only: the field whose values become columns. Null means stage. */
  groupByKey: string | null
  /** Calendar views only: the date field that places each record on a day. */
  calendarKey: string | null
  /** What a save has to carry back. Null for a view that is not stored yet. */
  updatedAt: Date | null
}

/** Reserved: /objects/:object/views/all/list must always resolve, even in a
 *  account where every saved view has been deleted. */
export const DEFAULT_VIEW_SLUG = 'all'

export const fallbackView = (object: RegistryObject, slug: string): ViewDefinition => {
  // A custom object has no seeded views, so it falls through to the defaults
  // below, which are "everything, newest first" — the right answer for one.
  const seeded = (CORE_VIEWS[object.key as keyof typeof CORE_VIEWS] ?? []).find((view) => view.slug === slug)
    ?? CORE_VIEWS[object.key as keyof typeof CORE_VIEWS]?.[0]
  return {
    id: null,
    slug: seeded?.slug ?? DEFAULT_VIEW_SLUG,
    name: seeded?.name ?? 'All records',
    kind: seeded?.kind ?? 'table',
    columns: seeded?.columns ?? object.fields.slice(0, 8).map((field) => field.key),
    filters: parseFilters(seeded?.filters ?? []),
    sorts: parseSorts(seeded?.sorts ?? []),
    isShared: true,
    ownerId: null,
    position: seeded?.position ?? 0,
    pinned: true,
    groupByKey: seeded?.groupBy ?? null,
    calendarKey: null,
    updatedAt: null,
  }
}

/** The stored field ids are read back as keys by looking them up in `fields`. */
const toDefinition = (
  fields: RegistryField[],
  row: {
    id: string
    slug: string
    name: string
    kind: 'table' | 'board' | 'calendar'
    columns: unknown
    filters: unknown
    sorts: unknown
    isShared: boolean
    ownerId: string | null
    position: number
    pinned: boolean
    groupByFieldId: string | null
    calendarFieldId: string | null
    updatedAt: Date
  },
): ViewDefinition => {
  const keyOf = (id: string | null) => fields.find((field) => field.id === id)?.key ?? null
  return {
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
    pinned: row.pinned,
    groupByKey: keyOf(row.groupByFieldId),
    calendarKey: keyOf(row.calendarFieldId),
    updatedAt: row.updatedAt,
  }
}

/** The view tabs a person can see: the shared ones plus their own. */
export const listViews = async (
  ctx: AccountContext,
  objectKey: string,
): Promise<ViewDefinition[]> => {
  const registry = await getRegistry(ctx)
  const object = objectOrThrow(registry, objectKey)

  const rows = await withAccount(ctx, (tx) =>
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
        pinned: savedView.pinned,
        groupByFieldId: savedView.groupByFieldId,
        calendarFieldId: savedView.calendarFieldId,
        updatedAt: savedView.updatedAt,
      })
      .from(savedView)
      .where(
        and(
          eq(savedView.objectId, object.id),
          ctx.actorId
            ? or(eq(savedView.isShared, true), eq(savedView.ownerId, ctx.actorId), isNull(savedView.ownerId))
            : eq(savedView.isShared, true),
        ),
      )
      .orderBy(desc(savedView.pinned), asc(savedView.position), asc(savedView.name)),
  )

  const views = rows.map((row) => toDefinition(object.fields, row))
  return views.length > 0 ? views : [fallbackView(object, DEFAULT_VIEW_SLUG)]
}

/** Resolves the slug in the URL. An unknown slug falls back to the default rather
 *  than 404ing, because a stale bookmark should still show the person their data. */
export const resolveView = async (
  ctx: AccountContext,
  objectKey: string,
  slug: string,
): Promise<{ view: ViewDefinition; matched: boolean }> => {
  const views = await listViews(ctx, objectKey)
  const found = views.find((view) => view.slug === slug)
  if (found) return { view: found, matched: true }
  const fallback = views.find((view) => view.slug === DEFAULT_VIEW_SLUG) ?? views[0]
  const registry = await getRegistry(ctx)
  const object = objectOrThrow(registry, objectKey)
  return { view: fallback ?? fallbackView(object, DEFAULT_VIEW_SLUG), matched: false }
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
  kind: 'table' | 'board' | 'calendar'
  columns: string[]
  filters: FilterGroup[]
  sorts: Sort[]
  /** Read when the view is created. A save never changes who owns or shares a view. */
  isShared?: boolean | undefined
  /** Board views. Null is stage. Absent keeps what is stored. */
  groupByKey?: string | null | undefined
  /** Calendar views. Null clears the date field. Absent keeps what is stored. */
  calendarKey?: string | null | undefined
  /** What the editor last read of the view it is overwriting; null when it is
   *  creating one. */
  expectedUpdatedAt: Date | null
}

export const saveView = async (
  ctx: AccountContext,
  input: SaveViewInput,
): Promise<ViewDefinition> =>
  mutate(ctx, 'saved_view', async (tx) => {
    const registry = await getRegistry(ctx)
    const object = objectOrThrow(registry, input.objectKey)
    const unknown = input.columns.filter((key) => !object.byKey.has(key))
    if (unknown.length > 0) {
      throw new Error(`${object.namePlural} has no field called ${unknown.join(', ')}.`)
    }

    const groupField = input.groupByKey ? groupableField(object, input.groupByKey) : null
    const calendarField = input.calendarKey ? placeableField(object, input.calendarKey) : null
    const placement = {
      ...(input.groupByKey === undefined ? {} : { groupByFieldId: groupField?.id ?? null }),
      ...(input.calendarKey === undefined ? {} : { calendarFieldId: calendarField?.id ?? null }),
    }

    const base = slugify(input.name)
    const values = {
      accountId: ctx.accountId,
      objectId: object.id,
      name: input.name.trim(),
      kind: input.kind,
      columns: input.columns,
      filters: input.filters,
      sorts: input.sorts,
    }

    if (input.id) {
      const [current] = await tx
        .select({ ownerId: savedView.ownerId, updatedAt: savedView.updatedAt })
        .from(savedView)
        .where(eq(savedView.id, input.id))
        .for('update')
      if (!current) throw new Error('That view no longer exists.')
      assertMine(current, ctx, 'edit')
      if (current.updatedAt.getTime() !== input.expectedUpdatedAt?.getTime()) {
        throw new ConflictError(current.updatedAt)
      }
      const [updated] = await tx
        .update(savedView)
        .set({ ...values, ...placement, updatedAt: new Date() })
        .where(eq(savedView.id, input.id))
        .returning()
      if (!updated) throw new Error('That view no longer exists.')
      return {
        result: toDefinition(object.fields, updated),
        audit: { entity: 'saved_view', entityId: updated.id, action: 'update', before: null, after: { ...values, ...placement } },
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

    const owned = { isShared: input.isShared ?? false, ownerId: ctx.actorId }
    const [created] = await tx
      .insert(savedView)
      .values({ ...values, ...placement, ...owned, slug, position: taken.size, pinned: true })
      .returning()
    if (!created) throw new Error('The view could not be saved.')

    return {
      result: toDefinition(object.fields, created),
      audit: { entity: 'saved_view', entityId: created.id, action: 'create', before: null, after: { ...values, ...placement, ...owned, slug } },
    }
  })

/** A view nobody owns is the account's, and anybody may rearrange it. A view
 *  somebody made is theirs, and only they or an admin may change it. */
const assertMine = (
  row: { ownerId: string | null },
  ctx: AccountContext,
  verb: string,
): void => {
  if (row.ownerId !== null && row.ownerId !== ctx.actorId && !isAdmin(ctx)) {
    throw new Error(`That view belongs to somebody else. Only they, or an admin, can ${verb} it.`)
  }
}

export const deleteView = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'saved_view', async (tx) => {
    const [row] = await tx
      .select({ slug: savedView.slug, name: savedView.name, ownerId: savedView.ownerId })
      .from(savedView)
      .where(eq(savedView.id, id))
    if (!row) throw new Error('That view has already been deleted.')
    assertMine(row, ctx, 'delete')
    if (row.slug === DEFAULT_VIEW_SLUG) {
      throw new Error('The default view is the address every link falls back to, so it cannot be deleted.')
    }
    await tx.delete(savedView).where(eq(savedView.id, id))
    return {
      result: undefined,
      audit: { entity: 'saved_view', entityId: id, action: 'delete', before: row, after: null },
    }
  })

/** Copy a view, filters and columns and all, as a starting point for a variation.
 *  The copy is always personal: duplicating somebody's shared view to tweak it
 *  should not put the tweak in front of the whole team. */
export const duplicateView = async (ctx: AccountContext, id: string): Promise<ViewDefinition> =>
  mutate(ctx, 'saved_view', async (tx) => {
    const [row] = await tx.select().from(savedView).where(eq(savedView.id, id))
    if (!row) throw new Error('That view no longer exists.')
    const registry = await getRegistry(ctx)

    const taken = new Set(
      (
        await tx
          .select({ slug: savedView.slug })
          .from(savedView)
          .where(eq(savedView.objectId, row.objectId))
      ).map((view) => view.slug),
    )
    taken.add(DEFAULT_VIEW_SLUG)
    const base = slugify(`${row.name} copy`)
    let slug = base
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`

    const values = {
      accountId: ctx.accountId,
      objectId: row.objectId,
      name: `${row.name} copy`,
      kind: row.kind,
      columns: row.columns,
      filters: row.filters,
      sorts: row.sorts,
      groupByFieldId: row.groupByFieldId,
      calendarFieldId: row.calendarFieldId,
      isShared: false,
      ownerId: ctx.actorId,
      slug,
      position: taken.size,
      pinned: true,
    }
    const [created] = await tx.insert(savedView).values(values).returning()
    if (!created) throw new Error('The view could not be copied.')

    return {
      result: toDefinition(registry.objects.flatMap((object) => object.fields), created),
      audit: { entity: 'saved_view', entityId: created.id, action: 'create', before: null, after: values },
    }
  })

/** The name only. Renaming through saveView would mean the caller sending back
 *  every column and filter it had loaded, which is how a rename quietly reverts
 *  somebody else's edit.
 *
 *  The slug does not follow the name: the address is what people paste, and a
 *  rename that broke every link into the view would be worse than a slug that
 *  reads a little stale. */
export const renameView = async (
  ctx: AccountContext,
  id: string,
  name: string,
): Promise<ViewDefinition> =>
  mutate(ctx, 'saved_view', async (tx) => {
    const [row] = await tx.select().from(savedView).where(eq(savedView.id, id))
    if (!row) throw new Error('That view no longer exists.')
    assertMine(row, ctx, 'rename')
    const registry = await getRegistry(ctx)

    const trimmed = name.trim()
    if (!trimmed) throw new Error('A view needs a name.')

    const [updated] = await tx
      .update(savedView)
      .set({ name: trimmed })
      .where(eq(savedView.id, id))
      .returning()
    if (!updated) throw new Error('That view no longer exists.')

    return {
      result: toDefinition(registry.objects.flatMap((object) => object.fields), updated),
      audit: { entity: 'saved_view', entityId: id, action: 'update', before: { name: row.name }, after: { name: trimmed } },
    }
  })

/** Whether a view takes a tab above the list. */
export const setViewPinned = async (
  ctx: AccountContext,
  id: string,
  pinned: boolean,
): Promise<void> =>
  mutate(ctx, 'saved_view', async (tx) => {
    const [row] = await tx
      .select({ ownerId: savedView.ownerId, slug: savedView.slug, pinned: savedView.pinned })
      .from(savedView)
      .where(eq(savedView.id, id))
    if (!row) throw new Error('That view no longer exists.')
    assertMine(row, ctx, 'pin')
    if (!pinned && row.slug === DEFAULT_VIEW_SLUG) {
      throw new Error('The default view is the tab every link falls back to, so it stays pinned.')
    }
    await tx.update(savedView).set({ pinned }).where(eq(savedView.id, id))
    return {
      result: undefined,
      audit: { entity: 'saved_view', entityId: id, action: 'update', before: { pinned: row.pinned }, after: { pinned } },
    }
  })

/** The tab order, as one list rather than one call per move, so a drag that
 *  shifts five tabs is one write and cannot half-apply.
 *
 *  Ids the caller cannot see, or that belong to another object, are refused
 *  rather than silently skipped: a partial reorder is a scrambled tab bar. */
export const reorderViews = async (
  ctx: AccountContext,
  objectKey: string,
  ids: string[],
): Promise<void> =>
  mutate(ctx, 'saved_view', async (tx) => {
    const registry = await getRegistry(ctx)
    const object = objectOrThrow(registry, objectKey)
    if (ids.length === 0) throw new Error('A reorder needs the tabs in their new order.')

    const rows = await tx
      .select({ id: savedView.id, ownerId: savedView.ownerId })
      .from(savedView)
      .where(and(eq(savedView.objectId, object.id), inArray(savedView.id, ids)))
    if (rows.length !== new Set(ids).size) {
      throw new Error('Some of those views no longer exist. Reload and try again.')
    }
    for (const row of rows) assertMine(row, ctx, 'reorder')

    // One statement, so the tab bar is never half-ordered: the new position of
    // each id is its index in the list the caller sent.
    await tx.execute(sql`
      update saved_view set position = ordering.position
        from (values ${sql.join(
          ids.map((id, index) => sql`(${id}::uuid, ${index}::int)`),
          sql`, `,
        )}) as ordering(id, position)
       where saved_view.id = ordering.id`)

    return {
      result: undefined,
      audit: { entity: 'saved_view', entityId: object.id, action: 'update', before: null, after: { order: ids } },
    }
  })
