import { calendarFields, listRecords, listViews, parseFilters, resolveView, withAccountReads } from '@rawr/db'
import { Alert, EmptyState } from '@rawr/ui'
import { notFound, redirect } from 'next/navigation'
import { IndexHeader } from '~/components/crm/index-header.tsx'
import { KpiStrip } from '~/components/crm/kpi-strip.tsx'
import { ListToolbar } from '~/components/crm/list-toolbar.tsx'
import { RecordTable } from '~/components/crm/record-table.tsx'
import { ViewTabs } from '~/components/crm/view-tabs.tsx'
import { decodeCursor, decodeFilters, decodeSort, duplicatesPath, encodeCursor, exportCsvPath, exportPath, importsPath, objectView, type ListParams, type ViewKind } from '~/lib/links.ts'
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

/** Shaped like an object key. The registry decides whether it is one. */
const USABLE_OBJECT_KEY = /^[a-z][a-z0-9_]{1,58}$/

type Params = { account: string; object: string; view: string }
type Search = {
  q?: string
  filters?: string
  sort?: string
  cursor?: string
  error?: string
  cols?: string
  limit?: string
  skip?: string
  /** The + in the top bar and "Add view" on the tab bar link here rather than
   *  carrying their own dialogs. */
  new?: string
  view?: string
}

/** What the screen shows: the columns a person chose in the URL, else the view's
 *  own, else the first few fields so an account that has saved nothing still has
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

/** Which shapes this object can be looked at in. A board needs a pipeline, which
 *  only a deal has; a calendar needs a date field, which the registry knows. */
const kindsFor = (object: Parameters<typeof calendarFields>[0]): ViewKind[] => [
  'list',
  ...(object.key === 'deal' ? (['board'] as const) : []),
  ...(calendarFields(object).length > 0 ? (['calendar'] as const) : []),
]

const ListPage = async ({
  params,
  searchParams,
}: {
  params: Promise<Params>
  searchParams: Promise<Search>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, object: objectParam, view: viewSlug } = await params
  // Not `isObjectKey`: an admin can invent an object, and its records are read
  // through exactly this page. Whether the key names one is the registry's
  // answer, and loadCrmContext below throws with a sentence if it does not.
  if (!USABLE_OBJECT_KEY.test(objectParam)) notFound()

  const search = await searchParams
  const ctx = contextFrom(session)

  // One transaction for the whole screen. Each of these reads used to open its
  // own, and BEGIN plus the set_config plus COMMIT is three network round trips
  // before a row is fetched.
  const { object, objects, lookups, canWrite, views, resolved, page, queryError } = await withAccountReads(ctx, async () => {
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
    redirect(objectView(account, objectParam, resolved.view.slug, 'list', search as ListParams))
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

  const exportHref = exportCsvPath(account, {
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

      <IndexHeader
        title={object.namePlural}
        currentObject={objectParam}
        objects={objects.map((other) => ({ key: other.key, label: other.namePlural, href: objectView(account, other.key, 'all') }))}
        addLabel={`Add ${object.namePlural.toLowerCase()}`}
        add={
          canWrite
            ? [
                { label: `Create ${object.nameSingular.toLowerCase()}`, href: objectView(account, objectParam, resolved.view.slug, 'list', { ...listParams, new: '1' } as ListParams) },
                { label: 'Import', href: importsPath(account) },
              ]
            : []
        }
        more={[
          { key: 'import', label: 'Import', href: importsPath(account) },
          { key: 'export', label: 'Export', href: exportPath(account) },
          ...(objectParam === 'contact' || objectParam === 'company'
            ? [{ key: 'duplicates', label: 'Manage duplicates', href: duplicatesPath(account, objectParam) }]
            : []),
        ]}
      />

      <ViewTabs
        account={account}
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
        kinds={kindsFor(object)}
        params={listParams}
        canWrite={canWrite}
      />

      <ListToolbar
        account={account}
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
        openCreate={search.new === '1'}
        openView={search.view === 'new'}
        allColumns={object.fields.map((field) => ({ key: field.key, label: field.label }))}
      />

      <KpiStrip
        account={account}
        object={objectParam}
        view={resolved.view.slug}
        params={listParams}
        filters={filters as never}
        hasRecords={(page?.total ?? page?.rows.length ?? 0) > 0}
      />

      {queryError ? (
        <EmptyState
          title="This view could not be read"
          description={queryError}
        />
      ) : (
        <RecordTable
          account={account}
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
          totalHint={page!.total}
          objectLabel={object.nameSingular}
          objectPlural={object.namePlural}
          bulkFields={bulkFields}
          exportHref={exportHref}
        />
      )}
    </div>
  )
}

export default ListPage
