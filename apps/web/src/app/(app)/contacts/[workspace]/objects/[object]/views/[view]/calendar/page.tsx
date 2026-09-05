import { calendarFields, isObjectKey, listViews, parseFilters, readCalendar, resolveView } from '@rawr/db'
import { Alert, cn } from '@rawr/ui'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { CalendarGrid } from '~/components/crm/calendar-grid.tsx'
import { ViewTabs } from '~/components/crm/view-tabs.tsx'
import { decodeFilters, objectView, type ListParams, type ViewKind } from '~/lib/links.ts'
import { loadCrmContext } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** The third way to look at a list: what is happening this month.
 *
 *  The month and the date field are both in the URL, so a calendar somebody
 *  navigated to pastes like every other screen, and Earlier and Later are plain
 *  links rather than state. */

type Params = { workspace: string; object: string; view: string }
type Search = { q?: string; filters?: string; month?: string; group?: string }

/** Today, as the server sees it. The grid only compares it to a stored day to
 *  decide which square to ring, and being an hour out on that once a year is a
 *  fair trade for not shipping a client component to draw a month. */
const todayIso = (): string => new Date().toISOString().slice(0, 10)

/** Which shapes this object can be looked at in. A board needs a pipeline, which
 *  only a deal has; a calendar needs a date field, which the registry knows. */
const kindsFor = (object: Parameters<typeof calendarFields>[0]): ViewKind[] => [
  'list',
  ...(object.key === 'deal' ? (['board'] as const) : []),
  ...(calendarFields(object).length > 0 ? (['calendar'] as const) : []),
]

const CalendarPage = async ({
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
  const [{ object, canWrite }, views, resolved] = await Promise.all([
    loadCrmContext(ctx, objectParam),
    listViews(ctx, objectParam),
    resolveView(ctx, objectParam, viewSlug),
  ])

  const placeable = calendarFields(object)
  // Nothing to lay out on. Better the list than an empty month with no
  // explanation of why it is empty.
  if (placeable.length === 0) redirect(objectView(workspace, objectParam, viewSlug, 'list'))

  const filters = search.filters ? parseFilters(decodeFilters(search.filters)) : resolved.view.filters
  const month = search.month ?? todayIso().slice(0, 7)
  // A saved view's group is a board's grouping, which is a stage, not a date.
  // Honoured only when it happens to name a field a calendar can use, so opening
  // the calendar on a view saved as a board is a calendar rather than an error
  // about stage_id. Asking for one by hand in the URL still says why it failed.
  const stored = placeable.some((field) => field.key === resolved.view.groupByKey)
    ? resolved.view.groupByKey
    : null
  const chosen = search.group ?? stored ?? placeable[0]!.key

  let calendar: Awaited<ReturnType<typeof readCalendar>> | null = null
  let problem: string | null = null
  try {
    calendar = await readCalendar(ctx, {
      object: objectParam,
      month,
      fieldKey: chosen,
      filters,
      search: search.q ?? '',
    })
  } catch (cause) {
    // A hand-edited field in a URL is the usual cause, and the message names the
    // ones that would have worked, so the first date field is worth one retry.
    problem = cause instanceof Error ? cause.message : String(cause)
    calendar = await readCalendar(ctx, {
      object: objectParam,
      month,
      fieldKey: placeable[0]!.key,
      filters,
      search: search.q ?? '',
    }).catch(() => null)
  }

  const listParams: ListParams = {
    ...(search.q ? { q: search.q } : {}),
    ...(search.filters ? { filters: search.filters } : {}),
    ...(search.group ? { group: search.group } : {}),
  }

  return (
    <div className="flex flex-col gap-3">
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
        currentKind="calendar"
        kinds={kindsFor(object)}
        params={listParams}
        canWrite={canWrite}
      />

      {problem ? (
        <Alert>
          {problem}
          {calendar ? ` Showing ${calendar.fieldLabel.toLowerCase()} instead.` : ''}
        </Alert>
      ) : null}

      {placeable.length > 1 ? (
        <nav aria-label="Place on" className="flex flex-wrap items-baseline gap-1">
          <span className="text-small text-secondary">Place on</span>
          {placeable.map((field) => (
            <Link
              key={field.key}
              href={objectView(workspace, objectParam, resolved.view.slug, 'calendar', {
                ...listParams,
                group: field.key,
                month,
              })}
              aria-current={field.key === calendar?.fieldKey ? 'true' : undefined}
              className={cn(
                'rounded-hs border px-2 py-1 no-underline',
                field.key === calendar?.fieldKey
                  ? 'border-line-interactive bg-accent-subtle text-link'
                  : 'border-line text-body hover:bg-fill',
              )}
            >
              {field.label}
            </Link>
          ))}
        </nav>
      ) : null}

      {calendar ? (
        <CalendarGrid
          workspace={workspace}
          object={objectParam}
          view={resolved.view.slug}
          month={calendar.month}
          today={todayIso()}
          entries={calendar.entries}
          truncated={calendar.truncated}
          fieldLabel={calendar.fieldLabel}
          params={listParams}
        />
      ) : null}
    </div>
  )
}

export default CalendarPage
