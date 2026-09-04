import { isObjectKey, listRecords, parseFilters, resolveView, listViews, withWorkspaceReads } from '@rawr/db'
import { Alert, EmptyState } from '@rawr/ui'
import { notFound, redirect } from 'next/navigation'
import { ListToolbar } from '~/components/crm/list-toolbar.tsx'
import { RecordTable } from '~/components/crm/record-table.tsx'
import { ViewTabs } from '~/components/crm/view-tabs.tsx'
import {
  decodeCursor,
  decodeFilters,
  decodeSort,
  encodeCursor,
  exportCsvPath,
  objectView,
  type ListParams,
} from '~/lib/links.ts'
import { loadCrmContext, toEditableFields, toFilterFields, toTableColumns } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'

const PAGE_SIZE = 50
/** The largest page the table offers. Above this a person is looking for the
 *  export, not a longer screen. */
const MAX_PAGE_SIZE = 100

const readLimit = (raw: string | undefined): number => {
  const asked = Number(raw)
  if (!Number.isFinite(asked)) return PAGE_SIZE
  return Math.min(Math.max(Math.trunc(asked), 1), MAX_PAGE_SIZE)
}

type Params = { workspace: string; object: string; view: string }
type Search = {
  q?: string
  filters?: string
  sort?: string
  cursor?: string
  error?: string
  cols?: string
  limit?: string
  skip?: string
}

/** What the screen shows: the columns a person chose in the URL, else the view's
 *  own, else the first few fields so a workspace that has saved nothing still has
 *  a table. Unknown keys are dropped rather than throwing, because this comes from
 *  an address somebody can hand-edit. */
const columnsFrom = (
  raw: string | undefined,
  stored: string[],
  object: { fields: { key: string }[]; byKey: Map<string, unknown> },
): string[] => {
  const asked = (raw ?? '').split(',').filter((key) => key && object.byKey.has(key))
  if (asked.length > 0) return asked
  return stored.length > 0 ? stored : object.fields.slice(0, 8).map((field) => field.key)
}

const ListPage = async ({
  params,
  searchParams,
}: {
  params: Promise<Params>
  searchParams: Promise<Search>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace, object: objectParam, view: viewSlug } = await params
  if (!isObjectKey(objectParam)) notFound()

  const search = await searchParams
  const ctx = contextFrom(session)

  // One transaction for the whole screen. Each of these reads used to open its
  // own, and BEGIN plus the set_config plus COMMIT is three network round trips
  // before a row is fetched.
  const { object, lookups, canWrite, views, resolved, page, queryError } = await withWorkspaceReads(ctx, async () => {
    const [crm, list, view] = await Promise.all([
      loadCrmContext(ctx, objectParam),
      listViews(ctx, objectParam),
      resolveView(ctx, objectParam, viewSlug),
    ])
    // A stale bookmark is redirected below, after the transaction closes.
    if (!view.matched && view.view.slug !== viewSlug) {
      return { ...crm, views: list, resolved: view, page: undefined, queryError: null }
    }

    // Anything in the URL wins over what the view stored, which is what makes a
    // filtered screen shareable without saving it first.
    const urlFilters = search.filters ? parseFilters(decodeFilters(search.filters)) : null
    const filters = urlFilters ?? view.view.filters
    const sorts = search.sort ? decodeSort(search.sort) : view.view.sorts
    const columns = columnsFrom(search.cols, view.view.columns, crm.object)

    try {
      const page = await listRecords(ctx, {
        object: objectParam,
        columns,
        filters,
        sorts,
        search: search.q ?? '',
        limit: readLimit(search.limit),
        cursor: decodeCursor(search.cursor),
        count: true,
      })
      return { ...crm, views: list, resolved: view, page, queryError: null }
    } catch (cause) {
      // A hand-edited filter in a URL is the usual cause. Say so instead of
      // showing a crash page.
      return { ...crm, views: list, resolved: view, page: undefined, queryError: cause instanceof Error ? cause.message : String(cause) }
    }
  })
  // A stale bookmark still shows the person their records, at the address the
  // view actually lives at, rather than a 404.
  if (!resolved.matched && resolved.view.slug !== viewSlug) {
    redirect(objectView(workspace, objectParam, resolved.view.slug, 'list', search as ListParams))
  }

  // Normalised, not cast: the toolbar reads group.conditions, and a hand-edited
  // URL holding a bare condition list has no groups in it at all.
  const urlFilters = search.filters ? parseFilters(decodeFilters(search.filters)) : null
  const filters = urlFilters ?? resolved.view.filters
  const sorts = search.sort ? decodeSort(search.sort) : resolved.view.sorts
  const columns = columnsFrom(search.cols, resolved.view.columns, object)

  // A bulk edit sets one value on many records, so a field that is unique per
  // record — an email, a domain, a name — would only ever produce duplicates.
  const bulkFields = canWrite
    ? toEditableFields(object, lookups).filter(
        (field) => !['email', 'domain', 'first_name', 'last_name', 'name'].includes(field.key),
      )
    : []

  const listParams: ListParams = {
    ...(search.q ? { q: search.q } : {}),
    ...(search.filters ? { filters: search.filters } : {}),
    ...(search.sort ? { sort: search.sort } : {}),
    ...(search.cursor ? { cursor: search.cursor } : {}),
    ...(search.cols ? { cols: search.cols } : {}),
    ...(search.limit ? { limit: search.limit } : {}),
    ...(search.skip ? { skip: search.skip } : {}),
  }

  const exportHref = exportCsvPath(workspace, {
    object: objectParam,
    columns: columns.join(','),
    ...(filters.length > 0 ? { filters: JSON.stringify(filters) } : {}),
    ...(sorts.length > 0
      ? { sort: `${sorts[0]!.direction === 'desc' ? '-' : ''}${sorts[0]!.key}` }
      : {}),
    ...(search.q ? { q: search.q } : {}),
  })

  return (
    // h-full and min-h-0 all the way down are what let the table fill the screen
    // and scroll under its own header rather than the page scrolling past it.
    <div className="flex h-full min-h-0 flex-col gap-3">
      {search.error ? (
        <Alert>
          {search.error}
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-lg font-medium">{object.namePlural}</h1>
        <p className="text-secondary">{resolved.view.name}</p>
      </div>

      <ViewTabs
        workspace={workspace}
        object={objectParam}
        views={views.map((view) => ({
          id: view.id,
          slug: view.slug,
          name: view.name,
          kind: view.kind,
          isShared: view.isShared,
          pinned: view.pinned,
        }))}
        current={resolved.view.slug}
        currentKind="list"
        params={listParams}
        canWrite={canWrite}
      />

      <ListToolbar
        workspace={workspace}
        object={objectParam}
        objectLabel={object.nameSingular}
        view={resolved.view.slug}
        viewId={resolved.view.id}
        viewLabel={resolved.view.name}
        kind="list"
        params={listParams}
        filters={filters as never}
        columns={columns}
        sorts={sorts}
        filterFields={toFilterFields(object)}
        createFields={toEditableFields(object, lookups)}
        canWrite={canWrite}
        exportHref={exportHref}
        allColumns={object.fields.map((field) => ({ key: field.key, label: field.label }))}
      />

      {queryError ? (
        <EmptyState
          title="This view could not be read"
          description={queryError}
        />
      ) : (
        <RecordTable
          workspace={workspace}
          object={objectParam}
          view={resolved.view.slug}
          columns={toTableColumns(object, columns)}
          rows={page!.rows.map((row) => ({
            id: row.id,
            displayName: row.displayName,
            values: row.values,
            labels: row.labels,
          }))}
          params={listParams}
          nextCursor={encodeCursor(page!.nextCursor)}
          sort={sorts[0] ?? null}
          totalHint={page!.total}
          objectLabel={object.nameSingular}
          bulkFields={bulkFields}
        />
      )}
    </div>
  )
}

export default ListPage
