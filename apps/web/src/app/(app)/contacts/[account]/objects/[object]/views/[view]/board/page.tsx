import { calendarFields, isObjectKey, listViews, parseFilters, readBoard, resolveView } from '@rawr/db'
import { Alert, FilterRow } from '@rawr/ui'
import { notFound, redirect } from 'next/navigation'
import { DealBoard, PipelinePicker } from '~/components/crm/deal-board.tsx'
import { ListToolbar } from '~/components/crm/list-toolbar.tsx'
import { IndexHeader } from '~/components/crm/index-header.tsx'
import { ViewTabs } from '~/components/crm/view-tabs.tsx'
import { decodeFilters, exportCsvPath, importsPath, objectView, type ListParams, type ViewKind } from '~/lib/links.ts'
import { loadCrmContext, toEditableFields, toFilterFields } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'

type Params = { account: string; object: string; view: string }
type Search = { q?: string; filters?: string; pipeline?: string; group?: string; new?: string; view?: string }

/** Which shapes this object can be looked at in. A board needs a pipeline, which
 *  only a deal has; a calendar needs a date field, which the registry knows. */
const kindsFor = (object: Parameters<typeof calendarFields>[0]): ViewKind[] => [
  'list',
  ...(object.key === 'deal' ? (['board'] as const) : []),
  ...(calendarFields(object).length > 0 ? (['calendar'] as const) : []),
]

const BoardPage = async ({
  params,
  searchParams,
}: {
  params: Promise<Params>
  searchParams: Promise<Search>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, object: objectParam, view: viewSlug } = await params
  if (!isObjectKey(objectParam)) notFound()
  // Deals are the only object with a pipeline, and the only one anybody has asked
  // to see as a board.
  if (objectParam !== 'deal') redirect(objectView(account, objectParam, viewSlug, 'list'))

  const search = await searchParams
  const ctx = contextFrom(session)
  const [{ object, objects, lookups, canWrite }, views, resolved] = await Promise.all([
    loadCrmContext(ctx, 'deal'),
    listViews(ctx, 'deal'),
    resolveView(ctx, 'deal', viewSlug),
  ])
  // Normalised, not cast: a hand-edited URL can hold a bare condition list, and
  // the toolbar below reads group.conditions off every entry.
  const filters = search.filters ? parseFilters(decodeFilters(search.filters)) : resolved.view.filters
  // No pipeline in the URL means the first one, which is Enterprise in production.
  const pipelineId = search.pipeline ?? lookups.pipelines[0]?.id ?? null

  // A board grouped by something other than stage spans every pipeline, because a
  // deal type or a product of interest is not a property of one pipeline.
  const groupBy = search.group ?? resolved.view.groupByKey ?? 'stage_id'
  const byStage = groupBy === 'stage_id'

  let board: Awaited<ReturnType<typeof readBoard>> | null = null
  let boardError: string | null = null
  try {
    board = await readBoard(ctx, {
      pipelineId: byStage ? pipelineId : null,
      filters,
      search: search.q ?? '',
      groupBy,
    })
  } catch (cause) {
    // A hand-edited group in a URL is the usual cause, and the message names the
    // fields that would have worked, so the default grouping is worth one retry.
    boardError = cause instanceof Error ? cause.message : String(cause)
    // A hand-edited filter is the other cause, and it survives that retry. Saying
    // so beats the crash screen the second throw used to reach.
    board = await readBoard(ctx, {
      pipelineId,
      filters,
      search: search.q ?? '',
      groupBy: 'stage_id',
    }).catch(() => null)
  }

  const listParams: ListParams = {
    ...(search.q ? { q: search.q } : {}),
    ...(search.filters ? { filters: search.filters } : {}),
    ...(search.pipeline ? { pipeline: search.pipeline } : {}),
    ...(search.group ? { group: search.group } : {}),
  }

  const exportHref = exportCsvPath(account, {
    object: 'deal',
    columns: (resolved.view.columns.length > 0 ? resolved.view.columns : ['name', 'stage_id', 'amount']).join(','),
    ...(filters.length > 0 ? { filters: JSON.stringify(filters) } : {}),
    ...(search.q ? { q: search.q } : {}),
  })

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <IndexHeader
        title={object.namePlural}
        currentObject={'deal'}
        objects={objects.map((other) => ({ key: other.key, label: other.namePlural, href: objectView(account, other.key, 'all') }))}
        addLabel={`Add ${object.namePlural.toLowerCase()}`}
        add={
          canWrite
            ? [
                { label: `Create ${object.nameSingular.toLowerCase()}`, href: objectView(account, 'deal', resolved.view.slug, 'board', { ...listParams, new: '1' } as ListParams) },
                { label: 'Import', href: importsPath(account) },
              ]
            : []
        }
        more={[
          { key: 'import', label: 'Import', href: importsPath(account) },
          { key: 'export', label: 'Export this view', href: exportHref },
        ]}
      />

      <ViewTabs
        account={account}
        object="deal"
        views={views.map((view) => ({
          id: view.id,
          slug: view.slug,
          name: view.name,
          kind: view.kind,
          isShared: view.isShared,
          pinned: view.pinned,
        }))}
        current={resolved.view.slug}
        currentKind="board"
        kinds={kindsFor(object)}
        params={listParams}
        canWrite={canWrite}
      />

      {boardError ? (
        <Alert>
          {boardError}
          {board ? ' Showing the board by stage instead.' : ''}
        </Alert>
      ) : null}

      {board && board.groupableFields.length > 1 ? (
        <FilterRow
          label="Group by"
          lead="Group by"
          items={board.groupableFields.map((field) => ({
            key: field.key,
            label: field.label,
            href: objectView(account, 'deal', resolved.view.slug, 'board', { ...listParams, group: field.key }),
            current: field.key === board.groupByKey,
          }))}
        />
      ) : null}

      <ListToolbar
        account={account}
        object="deal"
        objectLabel={object.nameSingular}
        view={resolved.view.slug}
        viewId={resolved.view.id}
        viewLabel={resolved.view.name}
        kind="board"
        params={listParams}
        filters={filters as never}
        columns={resolved.view.columns}
        sorts={resolved.view.sorts}
        filterFields={toFilterFields(object)}
        createFields={toEditableFields(object, lookups)}
        canWrite={canWrite}
        openCreate={search.new === '1'}
        openView={search.view === 'new'}
        allColumns={object.fields.map((field) => ({ key: field.key, label: field.label }))}
        trailing={
          byStage && lookups.pipelines.length > 1 ? (
            <PipelinePicker
              currentId={pipelineId ?? ''}
              pipelines={lookups.pipelines.map((pipeline) => ({
                id: pipeline.id,
                label: pipeline.label,
                href: objectView(account, 'deal', resolved.view.slug, 'board', { ...listParams, pipeline: pipeline.id }),
              }))}
            />
          ) : null
        }
      />

      {board && board.unassigned > 0 ? (
        <Alert tone="warning">
          {board.unassigned.toLocaleString()} deal{board.unassigned === 1 ? '' : 's'}{' '}
          {board.unassigned === 1 ? 'has' : 'have'} no {board.groupByLabel.toLowerCase()} on this board.{' '}
          {byStage
            ? 'Switch pipelines above to find them.'
            : `Filter on ${board.groupByLabel} being empty to see them.`}
        </Alert>
      ) : null}

      {board ? (
        <DealBoard
          account={account}
          columns={board.columns}
          groupByKey={board.groupByKey}
          canWrite={canWrite}
        />
      ) : null}
    </div>
  )
}

export default BoardPage
