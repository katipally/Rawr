import { calendarFields, listViews, parseFilters, readCalendar, resolveView } from '@rawr/db'
import { Alert, FilterRow } from '@rawr/ui'
import { notFound, redirect } from 'next/navigation'
import { CalendarGrid } from '~/components/crm/calendar-grid.tsx'
import { todayIn } from '~/components/crm/value.tsx'
import { IndexHeader } from '~/components/crm/index-header.tsx'
import { ListToolbar } from '~/components/crm/list-toolbar.tsx'
import { ViewTabs } from '~/components/crm/view-tabs.tsx'
import { decodeFilters, exportPath, importsPath, objectView, recordPath, type ListParams, type ViewKind } from '~/lib/links.ts'
import { loadCrmContext, toEditableFields, toFilterFields } from '~/server/crm.ts'
import { inSentence } from '~/lib/label-case.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** The third way to look at a list: what is happening this month.
 *
 *  The month and the date field are both in the URL, so a calendar somebody
 *  navigated to pastes like every other screen, and Earlier and Later are plain
 *  links rather than state. */

/** Shaped like an object key. The registry decides whether it is one. */
const USABLE_OBJECT_KEY = /^[a-z][a-z0-9_]{1,58}$/

type Params = { account: string; object: string; view: string }
type Search = { q?: string; filters?: string; month?: string; group?: string; new?: string; view?: string }

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

  const { account, object: objectParam, view: viewSlug } = await params
  // Not `isObjectKey`: an admin can invent an object, and its records are read
  // through exactly this page. Whether the key names one is the registry's
  // answer, and loadCrmContext below throws with a sentence if it does not.
  if (!USABLE_OBJECT_KEY.test(objectParam)) notFound()

  const search = await searchParams
  const ctx = contextFrom(session)
  const [{ object, objects, lookups, canWrite }, views, resolved] = await Promise.all([
    loadCrmContext(ctx, objectParam),
    listViews(ctx, objectParam),
    resolveView(ctx, objectParam, viewSlug),
  ])

  const placeable = calendarFields(object)
  // Nothing to lay out on. Better the list than an empty month with no
  // explanation of why it is empty.
  if (placeable.length === 0) redirect(objectView(account, objectParam, viewSlug, 'list'))

  const today = todayIn(session.timezone)
  const filters = search.filters ? parseFilters(decodeFilters(search.filters)) : resolved.view.filters
  const month = search.month ?? today.slice(0, 7)
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
      <IndexHeader
        title={object.namePlural}
        currentObject={objectParam}
        objects={objects.map((other) => ({ key: other.key, label: other.namePlural, href: objectView(account, other.key, 'all') }))}
        addLabel={`Add ${inSentence(object.namePlural)}`}
        add={
          canWrite
            ? [
                { label: `Create ${inSentence(object.nameSingular)}`, href: objectView(account, objectParam, resolved.view.slug, 'calendar', { ...listParams, new: '1' } as ListParams) },
                { label: 'Import', href: importsPath(account) },
              ]
            : []
        }
        more={[
          { key: 'import', label: 'Import', href: importsPath(account) },
          { key: 'export', label: 'Export', href: exportPath(account) },
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

      <ListToolbar
        account={account}
        object={objectParam}
        objectLabel={object.nameSingular}
        view={resolved.view.slug}
        viewId={resolved.view.id}
        viewLabel={resolved.view.name}
        kind="calendar"
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
      />

      {placeable.length > 1 ? (
        <FilterRow
          label="Place on"
          lead="Place on"
          items={placeable.map((field) => ({
            key: field.key,
            label: field.label,
            href: objectView(account, objectParam, resolved.view.slug, 'calendar', {
              ...listParams,
              group: field.key,
              month,
            }),
            current: field.key === calendar?.fieldKey,
          }))}
        />
      ) : null}

      {calendar ? (
        <CalendarGrid
          month={calendar.month}
          today={today}
          entries={calendar.entries.map((entry) => ({
            ...entry,
            href: recordPath(account, objectParam, entry.id),
          }))}
          truncated={calendar.truncated}
          fieldLabel={calendar.fieldLabel}
          monthHref={(month) =>
            objectView(account, objectParam, resolved.view.slug, 'calendar', {
              ...listParams,
              month,
            } as ListParams)
          }
        />
      ) : null}
    </div>
  )
}

export default CalendarPage
