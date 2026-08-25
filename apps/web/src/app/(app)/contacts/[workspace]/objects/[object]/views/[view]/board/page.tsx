import { isObjectKey, listViews, readBoard, resolveView } from '@rawr/db'
import { cn } from '@rawr/ui'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { DealBoard } from '~/components/crm/deal-board.tsx'
import { ListToolbar } from '~/components/crm/list-toolbar.tsx'
import { ViewTabs } from '~/components/crm/view-tabs.tsx'
import { decodeFilters, objectView, type ListParams } from '~/lib/links.ts'
import { loadCrmContext, toEditableFields, toFilterFields } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'

type Params = { workspace: string; object: string; view: string }
type Search = { q?: string; filters?: string; pipeline?: string }

const BoardPage = async ({
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
  // A board groups by pipeline stage, which only deals have.
  if (objectParam !== 'deal') redirect(objectView(workspace, objectParam, viewSlug, 'list'))

  const search = await searchParams
  const ctx = contextFrom(session)
  const { object, lookups, companies, canWrite } = await loadCrmContext(ctx, 'deal')

  const [views, resolved] = await Promise.all([listViews(ctx, 'deal'), resolveView(ctx, 'deal', viewSlug)])
  const filters = search.filters ? (decodeFilters(search.filters) as never) : resolved.view.filters
  // No pipeline in the URL means the first one, which is Enterprise in production.
  const pipelineId = search.pipeline ?? lookups.pipelines[0]?.id ?? null

  const board = await readBoard(ctx, { pipelineId, filters, search: search.q ?? '' })

  const listParams: ListParams = {
    ...(search.q ? { q: search.q } : {}),
    ...(search.filters ? { filters: search.filters } : {}),
    ...(search.pipeline ? { pipeline: search.pipeline } : {}),
  }

  const exportParams = new URLSearchParams({
    object: 'deal',
    columns: (resolved.view.columns.length > 0 ? resolved.view.columns : ['name', 'stage_id', 'amount']).join(','),
  })
  if (filters.length > 0) exportParams.set('filters', JSON.stringify(filters))
  if (search.q) exportParams.set('q', search.q)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-base font-medium">{object.namePlural}</h1>
        <p className="text-secondary">{resolved.view.name}</p>
      </div>

      <ViewTabs
        workspace={workspace}
        object="deal"
        views={views.map((view) => ({ slug: view.slug, name: view.name, kind: view.kind, isShared: view.isShared }))}
        current={resolved.view.slug}
        currentKind="board"
        params={listParams}
      />

      {lookups.pipelines.length > 1 ? (
        <nav aria-label="Pipeline" className="flex flex-wrap gap-1">
          {lookups.pipelines.map((pipeline) => (
            <Link
              key={pipeline.id}
              href={objectView(workspace, 'deal', resolved.view.slug, 'board', {
                ...listParams,
                pipeline: pipeline.id,
              })}
              aria-current={pipeline.id === pipelineId ? 'true' : undefined}
              className={cn(
                'rounded-hs border px-2 py-1 no-underline',
                pipeline.id === pipelineId
                  ? 'border-line-interactive bg-accent-subtle text-link'
                  : 'border-line text-secondary',
              )}
            >
              {pipeline.label}
            </Link>
          ))}
        </nav>
      ) : null}

      <ListToolbar
        workspace={workspace}
        object="deal"
        objectLabel={object.nameSingular}
        view={resolved.view.slug}
        viewId={null}
        kind="board"
        params={listParams}
        filters={filters as never}
        columns={resolved.view.columns}
        sorts={resolved.view.sorts}
        filterFields={toFilterFields(object)}
        createFields={toEditableFields(object, lookups, companies)}
        canWrite={canWrite}
        exportHref={`/contacts/${workspace}/export?${exportParams.toString()}`}
      />

      {board.unassigned > 0 ? (
        <p className="rounded-hs border border-warning bg-warning-subtle px-3 py-2">
          {board.unassigned.toLocaleString()} deal{board.unassigned === 1 ? ' sits' : 's sit'} in a stage that
          is not on this pipeline. Switch pipelines above to find them.
        </p>
      ) : null}

      <DealBoard workspace={workspace} columns={board.columns} canWrite={canWrite} />
    </div>
  )
}

export default BoardPage
