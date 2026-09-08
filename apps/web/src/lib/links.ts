
/** Every address in the CRM, built here and nowhere else.
 *
 *  The shape mirrors HubSpot's so muscle memory carries over: the account sits
 *  where HubSpot puts the portal id, and the /objects/.../views/:slug/list and
 *  /record/:object/:id segments are theirs. The one deliberate difference is
 *  readable object keys instead of HubSpot's 0-1 and 0-3 codes.
 *
 *    /contacts/datasaur/objects/contact/views/all/list
 *    /contacts/datasaur/objects/deal/views/all/board?pipeline=<id>
 *    /contacts/datasaur/record/contact/<id>?tab=activity&type=note
 *
 *  Everything that changes what is on screen lives in the path or the query
 *  string, so any screen a person is looking at can be pasted to someone else. */

export const CRM_ROOT = 'contacts'

/** An object in an address is a string, not one of the three. An admin can
 *  invent one, and its list and record pages are these same builders. Whether
 *  the key names a real object is the registry's answer, not a URL's. */

/** The reverse of every builder below: which account an address names, or null
 *  when it names none. Both scoped families put the slug in the same position,
 *  which is what lets one pattern read either.
 *
 *  Read by src/proxy.ts, to notice a link into an account the session is not on,
 *  and by the Google callback, to land somebody on the account their link asked
 *  for rather than on whichever membership came back first. */
const ACCOUNT_PATH = /^\/(?:contacts|meetings)\/([^/?#]+)(?:[/?#]|$)/

export const accountInPath = (path: string | null | undefined): string | null => {
  const found = path ? ACCOUNT_PATH.exec(path)?.[1] : null
  if (!found) return null
  try {
    return decodeURIComponent(found)
  } catch {
    // A half-escaped slug from a hand-edited link. It cannot match a real
    // account, and guessing at it is worse than saying there was none.
    return null
  }
}

/** The URL segment for a view. The stored kind is 'table', the segment is
 *  'list', and they have differed since before there was a board; the other two
 *  are the same word in both places. */
export type ViewKind = 'list' | 'board' | 'calendar'

/** Every member is optionally undefined so a caller can clear one by passing
 *  undefined rather than having to rebuild the object. */
export type ListParams = {
  q?: string | undefined
  /** JSON filter groups, for a filter set that has not been saved as a view. */
  filters?: string | undefined
  sort?: string | undefined
  cursor?: string | undefined
  pipeline?: string | undefined
  /** Board only: which field's values become the columns. */
  group?: string | undefined
  /** Calendar only: the month on screen, as 2026-09. In the URL for the reason
   *  the filters are — a month somebody navigated to should paste — and it is
   *  what makes Earlier and Later plain links rather than state. */
  month?: string | undefined
  /** Comma-separated field keys, when a person has chosen columns that the saved
   *  view does not hold. In the URL for the same reason filters are: a screen
   *  somebody arranged should paste. */
  cols?: string | undefined
  /** Rows per page. In the URL so a link to page two shows the same page two. */
  limit?: string | undefined
  /** How many rows the pages before this one held. Carried so the pager can say
   *  "Showing 51-100" on a keyset list, which has no page numbers to count from. */
  skip?: string | undefined
}

const query = (params: Record<string, string | number | undefined | null>): string => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const rendered = search.toString()
  return rendered ? `?${rendered}` : ''
}

/** The front door: the Monday screen, not a list. */
export const accountHome = (account: string): string => `/${CRM_ROOT}/${account}/home`

export const objectView = (
  account: string,
  object: string,
  view: string,
  kind: ViewKind = 'list',
  params: ListParams = {},
): string =>
  `/${CRM_ROOT}/${account}/objects/${object}/views/${view}/${kind}${query(params)}`

/** `tab` is Overview or Activities, `type` filters the timeline, and the last
 *  three are the quick-action row asking a panel that is already on the page to
 *  open: log an activity of this kind, start a task, start an email. They are in
 *  the address rather than in component state so "log a call on this deal" is a
 *  link somebody can be sent. */
export const recordPath = (
  account: string,
  object: string,
  id: string,
  params: {
    tab?: string | undefined
    type?: string | undefined
    log?: string | undefined
    task?: string | undefined
    compose?: string | undefined
  } = {},
): string => `/${CRM_ROOT}/${account}/record/${object}/${id}${query(params)}`

/** The + in the top bar. It lands on the object's own list, which is where the
 *  create dialog lives, so there is one create form per object rather than a
 *  second copy in the shell that would have to learn the same fields. */
export const createRecordPath = (account: string, object: string): string =>
  `${objectView(account, object, 'all')}?new=1`

/** The export screen, and the file it hands over. The CSV lives one segment
 *  deeper than the page so the page has an address of its own: a download route
 *  cannot also be a screen somebody browses to. */
export const exportPath = (account: string): string => `/${CRM_ROOT}/${account}/export`

export const duplicatesPath = (account: string, object?: 'contact' | 'company'): string =>
  `/${CRM_ROOT}/${account}/duplicates${object && object !== 'contact' ? `?object=${object}` : ''}`

export const exportCsvPath = (
  account: string,
  params: { object: string; columns?: string; filters?: string; sort?: string; q?: string },
): string => `/${CRM_ROOT}/${account}/export/csv${query(params)}`

export const importsPath = (account: string, id?: string): string =>
  id ? `/${CRM_ROOT}/${account}/import/${id}` : `/${CRM_ROOT}/${account}/import`

/** Forms live under the same account-addressed tree as every other surface, so
 *  a link to one form, or to the review queue filtered to a state, pastes like
 *  anything else. */
export const formsPath = (account: string, id?: string): string =>
  id ? `/${CRM_ROOT}/${account}/forms/${id}` : `/${CRM_ROOT}/${account}/forms`

export const submissionsPath = (
  account: string,
  params: { state?: string; form?: string; before?: string } = {},
): string => `/${CRM_ROOT}/${account}/submissions${query(params)}`

/** F4. One page view, addressed by its own id, so the screen a salesperson is
 *  looking at pastes into Slack like every other surface. The account is in the
 *  path for the same reason it is everywhere else. */
export const pageViewPath = (account: string, id: string): string =>
  `/${CRM_ROOT}/${account}/activity/${id}`

/** Everything under /settings is account configuration rather than a record, so
 *  none of it carries an account in the path: a session is already in exactly one.
 *  Kept in one list so the settings sub-navigation and the pages agree. */
export const sitesPath = (): string => '/settings/sites'

export const membersPath = (): string => '/settings/members'

export const propertiesPath = (object?: string): string =>
  object ? `/settings/properties?object=${object}` : '/settings/properties'

export const objectsPath = (): string => '/settings/objects'

export const pipelinesPath = (): string => '/settings/pipelines'

/** F1 phase B. Connected mailboxes, their sync state, and the exclusion lists. */
export const mailboxesPath = (): string => '/settings/mailboxes'

export const lifecyclePath = (): string => '/settings/lifecycle'

export const automationsPath = (): string => '/settings/automations'

export const subscriptionsPath = (): string => '/settings/subscriptions'

/** Outgoing webhooks and unmatched inbound events. Connecting a provider is an
 *  app's own settings tab, so a "connect X" link lands there. */
export const integrationsPath = (kind?: string): string =>
  kind ? appPath(kind, 'settings') : '/settings/integrations'

/** Connected apps sit above an account, because the credential belongs to the
 *  account, and outside settings, because they have a frame of their own the
 *  way HubSpot's do. */
export const appsPath = (): string => '/apps'
export const availableAppsPath = (): string => '/apps/available'
export type AppTab = 'overview' | 'settings' | 'insights'
export const appPath = (kind: string, tab: AppTab = 'overview'): string =>
  tab === 'overview' ? `/apps/${kind}` : `/apps/${kind}?tab=${tab}`

/** Segments live in the CRM tree, not settings: a segment is a view of records
 *  that salespeople open, not configuration an admin sets once. */
export const segmentsPath = (account: string, id?: string): string =>
  id ? `/${CRM_ROOT}/${account}/segments/${id}` : `/${CRM_ROOT}/${account}/segments`

export type TaskView = 'all' | 'today' | 'overdue' | 'upcoming' | 'done'
export const tasksPath = (
  account: string,
  params: { view?: TaskView; mine?: '1'; q?: string; new?: '1' } = {},
): string =>
  `/${CRM_ROOT}/${account}/tasks${query(params)}`

/** The shared inbox. Every filter is in the address, so a filtered view pastes
 *  into Slack and the back button works. */
export const inboxPath = (
  account: string,
  params: {
    scope?: string | undefined
    mailbox?: string | undefined
    unreplied?: string | undefined
    unread?: string | undefined
    q?: string | undefined
  } = {},
): string => `/${CRM_ROOT}/${account}/inbox${query(params)}`

export const threadPath = (account: string, threadId: string): string =>
  `/${CRM_ROOT}/${account}/inbox/${threadId}`

/** Sequences live in the CRM tree, not settings: they are outreach salespeople
 *  run, not configuration an admin sets once. */
export const sequencesPath = (account: string): string => `/${CRM_ROOT}/${account}/sequences`

/** The six reports. `tab` is the report, `from` and `to` are the range, so a
 *  report worth looking at is a link somebody can send. */
export const reportsPath = (
  account: string,
  params: { tab?: string; from?: string; to?: string } = {},
): string => {
  const { tab, ...rest } = params
  return `/${CRM_ROOT}/${account}/reports${tab ? `/${tab}` : ''}${query(rest)}`
}

/** B11. One assembled dashboard, carrying the range it is read over. */
export const dashboardPath = (
  account: string,
  id: string,
  params: { from?: string; to?: string } = {},
): string => `/${CRM_ROOT}/${account}/reports/dashboards/${id}${query(params)}`

/** Brevo's seam: the audience and the opt-out are Rawr's, the send is Brevo's. */
export const newsletterPath = (account: string): string => `/${CRM_ROOT}/${account}/newsletter`

/** Words to reuse, beside the sequences that use them. HubSpot files these under
 *  Sales as Message Templates; the same place, by the same reasoning. */
export const templatesPath = (account: string): string => `/${CRM_ROOT}/${account}/templates`

export const sequencePath = (account: string, id: string): string =>
  `/${CRM_ROOT}/${account}/sequences/${id}`

export const enrollmentsPath = (account: string, id: string, params: { state?: string | undefined } = {}): string =>
  `/${CRM_ROOT}/${account}/sequences/${id}/enrollments${query(params)}`

/** Where sequence pixels and click redirects are served from. */
export const trackingPath = (): string => '/settings/tracking'

/** Booking sits under its own root, the way HubSpot puts scheduling pages under
 *  /meetings/:portalId rather than inside the contacts app. Same rule as everything
 *  else: the account is in the path, so any screen pastes. */
export const MEETINGS_ROOT = 'meetings'

export const bookingPagesPath = (account: string, id?: string): string =>
  id ? `/${MEETINGS_ROOT}/${account}/pages/${id}` : `/${MEETINGS_ROOT}/${account}/pages`

/** The list with the create dialog already open, for the Create menu. */
export const newBookingPagePath = (account: string): string =>
  `/${MEETINGS_ROOT}/${account}/pages?new=1`

export const bookedPath = (
  account: string,
  params: { when?: 'upcoming' | 'past'; page?: string; host?: string; state?: string } = {},
): string => `/${MEETINGS_ROOT}/${account}/booked${query(params)}`

/** A person's own working hours, and an admin looking at somebody else's. The user
 *  is a query parameter rather than a path segment because the default subject is
 *  always "me", and a link with nobody named still opens on the right person. */
export const availabilityPath = (account: string, params: { user?: string; month?: string } = {}): string =>
  `/${MEETINGS_ROOT}/${account}/availability${query(params)}`

/** The month: meetings booked with somebody and tasks due from them. What the
 *  rail's Calendar means to a salesperson. */
export const calendarPath = (
  account: string,
  params: { month?: string; who?: string } = {},
): string => `/${MEETINGS_ROOT}/${account}/calendar${query(params)}`

/** Which Google accounts Rawr may read free-busy from. Plumbing, not a calendar,
 *  which is why the rail no longer points here. */
export const calendarsPath = (account: string): string =>
  `/${MEETINGS_ROOT}/${account}/calendars`

/** The public booking page. Absolute elsewhere; relative here because the app
 *  links to it too, from the page editor's preview. */
export const bookingPublicPath = (
  accountSlug: string,
  slug: string,
  params: {
    month?: string | undefined
    date?: string | undefined
    tz?: string | undefined
    slot?: string | undefined
    /** Where a script that confirmed a booking and then failed sends the person:
     *  the same booking, shown by the page itself, with the manage tokens they
     *  would otherwise only have had in an email that may not have arrived yet.
     *
     *  `e`, `err`, `w` and `hold` used to sit here too, for a no-JavaScript path
     *  that posted a form per step. That path went in 75cfaa7 and the page reads
     *  none of the four. */
    confirmed?: string | undefined
    at?: string | undefined
    r?: string | undefined
    c?: string | undefined
  } = {},
): string => `/b/${accountSlug}/${slug}${query(params)}`

export const bookingManagePath = (purpose: 'cancel' | 'reschedule', token: string): string =>
  `/b/manage/${purpose}/${token}`

/** The meeting as a calendar file. Addressed by the reschedule token because it is
 *  the credential the attendee already holds, and it grants nothing the manage page
 *  behind the same token does not already show. */
export const bookingIcsPath = (token: string): string => `/b/ics/${token}.ics`

/** Settings has no account segment: a person belongs to one at a time and the
 *  switcher in the shell is what moves them. Kept as functions anyway so the day
 *  that changes is one edit here. */
export const agentAccessPath = (): string => '/settings/agent'

/** The signed-in person's own screen: identity, roles, timezone, connected Google services, sessions. */
export const accountPath = (): string => '/settings/account'

export const failedJobsPath = (): string => '/settings/jobs'

/** The company above this account: its accounts, its seats, its history. */
export const defaultsPath = (): string => '/settings/defaults'

export const teamsPath = (): string => '/settings/teams'

export const auditPath = (): string => '/settings/audit'

/** The public invitation link. Absolute when it is put in front of a person to
 *  send; relative here because the app links to it too. */
export const invitePath = (token: string): string => `/invite/${token}`

/** A sort is one field and a direction, written the way a person would type it:
 *  `-close_date` for newest first. Kept short because it lives in a URL people
 *  paste into Slack. */
export const decodeSort = (value: string | null | undefined): { key: string; direction: 'asc' | 'desc' }[] => {
  if (!value) return []
  const trimmed = value.trim()
  if (!trimmed) return []
  return trimmed.startsWith('-')
    ? [{ key: trimmed.slice(1), direction: 'desc' }]
    : [{ key: trimmed, direction: 'asc' }]
}

/** Filters travel as JSON so a saved view and an ad-hoc URL are the same shape.
 *  Unparseable input is dropped rather than throwing: a mangled link should still
 *  show the person their records. */
/** Whatever JSON was in the URL, and nothing more. A person can hand-edit this,
 *  so the result is not a FilterGroup[] until parseFilters has read it: pass it
 *  through that before anything renders from it. */
export const decodeFilters = (value: string | null | undefined): unknown => {
  if (!value) return []
  try {
    return JSON.parse(value) as unknown
  } catch {
    return []
  }
}

export const encodeFilters = (filters: unknown): string | undefined => {
  if (!Array.isArray(filters) || filters.length === 0) return undefined
  return JSON.stringify(filters)
}

/** Cursors are opaque to the reader but must survive a paste, so they are base64
 *  of the keyset pair rather than two more visible query parameters.
 *
 *  btoa/atob rather than Buffer: this module is imported by client components, and
 *  Buffer is not a browser global. Cursor values are ids, numbers and ISO
 *  timestamps, so they are always ASCII. */
const toBase64Url = (value: string): string =>
  btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const fromBase64Url = (value: string): string =>
  atob(value.replace(/-/g, '+').replace(/_/g, '/'))

export const encodeCursor = (cursor: { value: string | number | null; id: string } | null): string | undefined => {
  if (!cursor) return undefined
  return toBase64Url(JSON.stringify(cursor))
}

export const decodeCursor = (
  value: string | null | undefined,
): { value: string | number | null; id: string } | null => {
  if (!value) return null
  try {
    const parsed = JSON.parse(fromBase64Url(value)) as {
      value?: unknown
      id?: unknown
    }
    if (typeof parsed.id !== 'string') return null
    const raw = parsed.value
    return {
      id: parsed.id,
      value: typeof raw === 'string' || typeof raw === 'number' ? raw : null,
    }
  } catch {
    return null
  }
}
