import { calendarFields, listViews, parseFilters, readCalendar, resolveView } from '@rawr/db'
import { Alert, FilterRow } from '@rawr/ui'
import { notFound, redirect } from 'next/navigation'
import { CalendarGrid } from '~/components/crm/calendar-grid.tsx'
import { todayIn } from '~/lib/format.ts'
import { IndexHeader } from '~/components/crm/index-header.tsx'
import { FiltersDock } from '~/components/crm/filters-dock.tsx'
import { ListToolbar } from '~/components/crm/list-toolbar.tsx'
import { ViewTabs } from '~/components/crm/view-tabs.tsx'
import { decodeFilters, exportPath, importsPath, objectView, recordPath, type ListParams, type ViewKind } from '~/lib/links.ts'
import { loadCrmContext, toEditableFields, toFilterFields } from '~/server/crm.ts'
import { inSentence } from '~/lib/label-case.ts'
import { isReadable } from '~/server/errors.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** The third way to look at a list: what is happening this month.
 *
 *  The month and the date field are both in the URL, so a calendar somebody
 *  navigated to pastes like every other screen, and Earlier and Later are plain
 *  links rather than state. */

/** Shaped like an object key. The registry decides whether it is one. */
const USABLE_OBJECT_KEY = /^[a-z][a-z0-9_]{1,58}$/

/** A month from a URL goes into a date cast, and Postgres refuses `2026-13`. */
const USABLE_MONTH = /^[1-9]\d{3}-(0[1-9]|1[0-2])/

type Params = { account: string; object: string; view: string }
type Search = { q?: string; filters?: string; pipeline?: string; month?: string; group?: string; new?: string; view?: string }

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
  // answer, and loadCrmContext below answers 404 if it does not.
  if (!USABLE_OBJECT_KEY.test(objectParam)) notFound()

  const search = await searchParams
  const ctx = contextFrom(session)
  // Alone and first: for a key that is not an object the reads beside it throw
  // plain errors of their own, and one of those would reach the error screen
  // before the 404 did.
  const { object, objects, lookups, canWrite } = await loadCrmContext(ctx, objectParam)
  const [views, resolved] = await Promise.all([
    listViews(ctx, objectParam),
    resolveView(ctx, objectParam, viewSlug),
  ])

  const placeable = calendarFields(object)
  // Nothing to lay out on. Better the list than an empty month with no
  // explanation of why it is empty.
  if (placeable.length === 0) redirect(objectView(account, objectParam, viewSlug, 'list'))

  const today = todayIn(session.accountTimezone)
  const filters = search.filters ? parseFilters(decodeFilters(search.filters)) : resolved.view.filters
  const month = search.month && USABLE_MONTH.test(search.month) ? search.month : today.slice(0, 7)
  // Asking for a field the calendar cannot use in the URL still says why it failed.
  const stored = placeable.some((field) => field.key === resolved.view.calendarKey)
    ? resolved.view.calendarKey
    : null
  const unusable = search.group !== undefined && !placeable.some((field) => field.key === search.group)
  const chosen = unusable ? placeable[0]!.key : (search.group ?? stored ?? placeable[0]!.key)

  let problem: string | null = unusable
    ? `A calendar cannot be laid out on "${search.group}". Try one of: ${placeable.map((field) => field.label).join(', ')}.`
    : null
  let calendar: Awaited<ReturnType<typeof readCalendar>> | null = null
  try {
    calendar = await readCalendar(ctx, {
      object: objectParam,
      month,
      fieldKey: chosen,
      filters,
      search: search.q ?? '',
    })
  } catch (cause) {
    // A hand-edited filter in a URL is the usual cause. Only a sentence the data
    // layer wrote for a person is shown; a driver error carries the statement.
    if (!isReadable(cause)) throw cause
    problem = cause.message
  }

  const listParams: ListParams = {
    ...(search.q ? { q: search.q } : {}),
    ...(search.filters ? { filters: search.filters } : {}),
    ...(search.group ? { group: search.group } : {}),
    ...(search.pipeline ? { pipeline: search.pipeline } : {}),
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
        params={listParams}
        canWrite={canWrite}
      />

      {problem ? (
        <Alert>
          {problem}
          {calendar ? ` Showing ${calendar.fieldLabel.toLowerCase()} instead.` : ''}
        </Alert>
      ) : null}

      <FiltersDock>
        <ListToolbar
          account={account}
          object={objectParam}
          objectLabel={object.nameSingular}
          view={resolved.view.slug}
          viewId={resolved.view.id}
          viewVersion={resolved.view.updatedAt?.toISOString() ?? null}
          viewLabel={resolved.view.name}
          kind="calendar"
          kinds={kindsFor(object)}
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
          calendarKey={chosen}
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
              href: recordPath(account, objectParam, entry.id, {
                from: objectView(account, objectParam, resolved.view.slug, 'calendar', {
                  ...listParams,
                  group: calendar.fieldKey,
                  month,
                }),
              }),
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
      </FiltersDock>
    </div>
  )
}

export default CalendarPage
