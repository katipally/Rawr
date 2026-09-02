import { isObjectKey, listRecords, resolveView, listViews, withWorkspaceReads } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import { notFound, redirect } from 'next/navigation'
import { ListToolbar } from '~/components/crm/list-toolbar.tsx'
import { RecordTable } from '~/components/crm/record-table.tsx'
import { ViewTabs } from '~/components/crm/view-tabs.tsx'
import {
  decodeCursor,
  decodeFilters,
  decodeSort,
  encodeCursor,
  objectView,
  type ListParams,
} from '~/lib/links.ts'
import { loadCrmContext, toEditableFields, toFilterFields, toTableColumns } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'

const PAGE_SIZE = 50

type Params = { workspace: string; object: string; view: string }
type Search = { q?: string; filters?: string; sort?: string; cursor?: string; error?: string }

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
  const { object, lookups, canWrite, views, resolved } = await withWorkspaceReads(ctx, async () => {
    const crm = await loadCrmContext(ctx, objectParam)
    const [list, view] = await Promise.all([
      listViews(ctx, objectParam),
      resolveView(ctx, objectParam, viewSlug),
    ])
    return { ...crm, views: list, resolved: view }
  })
  // A stale bookmark still shows the person their records, at the address the
  // view actually lives at, rather than a 404.
  if (!resolved.matched && resolved.view.slug !== viewSlug) {
    redirect(objectView(workspace, objectParam, resolved.view.slug, 'list', search as ListParams))
  }

  // Anything in the URL wins over what the view stored, which is what makes a
  // filtered screen shareable without saving it first.
  const urlFilters = search.filters ? (decodeFilters(search.filters) as never) : null
  const filters = urlFilters ?? resolved.view.filters
  const sorts = search.sort ? decodeSort(search.sort) : resolved.view.sorts
  const columns = resolved.view.columns.length > 0 ? resolved.view.columns : object.fields.slice(0, 8).map((f) => f.key)

  let page
  let queryError: string | null = null
  try {
    page = await listRecords(ctx, {
      object: objectParam,
      columns,
      filters,
      sorts,
      search: search.q ?? '',
      limit: PAGE_SIZE,
      cursor: decodeCursor(search.cursor),
      count: true,
    })
  } catch (cause) {
    // A hand-edited filter in a URL is the usual cause. Say so instead of
    // showing a crash page.
    queryError = cause instanceof Error ? cause.message : String(cause)
  }

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
  }

  const exportParams = new URLSearchParams({ object: objectParam, columns: columns.join(',') })
  if (filters.length > 0) exportParams.set('filters', JSON.stringify(filters))
  if (sorts.length > 0) exportParams.set('sort', `${sorts[0]!.direction === 'desc' ? '-' : ''}${sorts[0]!.key}`)
  if (search.q) exportParams.set('q', search.q)

  return (
    // h-full and min-h-0 all the way down are what let the table fill the screen
    // and scroll under its own header rather than the page scrolling past it.
    <div className="flex h-full min-h-0 flex-col gap-3">
      {search.error ? (
        <p role="alert" className="rounded-hs border border-error bg-error-subtle px-3 py-2 text-error">
          {search.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-lg font-medium">{object.namePlural}</h1>
        <p className="text-secondary">{resolved.view.name}</p>
      </div>

      <ViewTabs
        workspace={workspace}
        object={objectParam}
        views={views.map((view) => ({ slug: view.slug, name: view.name, kind: view.kind, isShared: view.isShared }))}
        current={resolved.view.slug}
        currentKind="list"
        params={listParams}
      />

      <ListToolbar
        workspace={workspace}
        object={objectParam}
        objectLabel={object.nameSingular}
        view={resolved.view.slug}
        viewId={null}
        kind="list"
        params={listParams}
        filters={filters as never}
        columns={columns}
        sorts={sorts}
        filterFields={toFilterFields(object)}
        createFields={toEditableFields(object, lookups)}
        canWrite={canWrite}
        exportHref={`/contacts/${workspace}/export?${exportParams.toString()}`}
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
