import type { ObjectKey } from '@rawr/db'

/** Every address in the CRM, built here and nowhere else.
 *
 *  The shape mirrors HubSpot's so muscle memory carries over: the workspace sits
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

/** The reverse of every builder below: which workspace an address names, or null
 *  when it names none. Both scoped families put the slug in the same position,
 *  which is what lets one pattern read either.
 *
 *  Read by src/proxy.ts, to notice a link into a workspace the session is not on,
 *  and by the Google callback, to land somebody on the workspace their link asked
 *  for rather than on whichever membership came back first. */
const WORKSPACE_PATH = /^\/(?:contacts|meetings)\/([^/?#]+)(?:[/?#]|$)/

export const workspaceInPath = (path: string | null | undefined): string | null => {
  const found = path ? WORKSPACE_PATH.exec(path)?.[1] : null
  if (!found) return null
  try {
    return decodeURIComponent(found)
  } catch {
    // A half-escaped slug from a hand-edited link. It cannot match a real
    // workspace, and guessing at it is worse than saying there was none.
    return null
  }
}

export type ViewKind = 'list' | 'board'

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
export const workspaceHome = (workspace: string): string => `/${CRM_ROOT}/${workspace}/home`

export const objectView = (
  workspace: string,
  object: ObjectKey,
  view: string,
  kind: ViewKind = 'list',
  params: ListParams = {},
): string =>
  `/${CRM_ROOT}/${workspace}/objects/${object}/views/${view}/${kind}${query(params)}`

export const recordPath = (
  workspace: string,
  object: ObjectKey,
  id: string,
  params: { tab?: string; type?: string } = {},
): string => `/${CRM_ROOT}/${workspace}/record/${object}/${id}${query(params)}`

/** The + in the top bar. It lands on the object's own list, which is where the
 *  create dialog lives, so there is one create form per object rather than a
 *  second copy in the shell that would have to learn the same fields. */
export const createRecordPath = (workspace: string, object: ObjectKey): string =>
  `${objectView(workspace, object, 'all')}?new=1`

export const importsPath = (workspace: string, id?: string): string =>
  id ? `/${CRM_ROOT}/${workspace}/import/${id}` : `/${CRM_ROOT}/${workspace}/import`

/** Forms live under the same workspace-addressed tree as every other surface, so
 *  a link to one form, or to the review queue filtered to a state, pastes like
 *  anything else. */
export const formsPath = (workspace: string, id?: string): string =>
  id ? `/${CRM_ROOT}/${workspace}/forms/${id}` : `/${CRM_ROOT}/${workspace}/forms`

export const submissionsPath = (
  workspace: string,
  params: { state?: string; form?: string } = {},
): string => `/${CRM_ROOT}/${workspace}/submissions${query(params)}`

/** F4. One page view, addressed by its own id, so the screen a salesperson is
 *  looking at pastes into Slack like every other surface. The workspace is in the
 *  path for the same reason it is everywhere else. */
export const pageViewPath = (workspace: string, id: string): string =>
  `/${CRM_ROOT}/${workspace}/activity/${id}`

/** Everything under /settings is workspace configuration rather than a record, so
 *  none of it carries a workspace in the path: a session is already in exactly one.
 *  Kept in one list so the settings sub-navigation and the pages agree. */
export const sitesPath = (): string => '/settings/sites'

export const membersPath = (): string => '/settings/members'

export const propertiesPath = (object?: string): string =>
  object ? `/settings/properties?object=${object}` : '/settings/properties'

export const pipelinesPath = (): string => '/settings/pipelines'

/** F1 phase B. Connected mailboxes, their sync state, and the exclusion lists. */
export const mailboxesPath = (): string => '/settings/mailboxes'

export const lifecyclePath = (): string => '/settings/lifecycle'

export const subscriptionsPath = (): string => '/settings/subscriptions'

export const integrationsPath = (kind?: string): string =>
  kind ? `/settings/integrations?open=${kind}` : '/settings/integrations'

/** Segments live in the CRM tree, not settings: a segment is a view of records
 *  that salespeople open, not configuration an admin sets once. */
export const segmentsPath = (workspace: string, id?: string): string =>
  id ? `/${CRM_ROOT}/${workspace}/segments/${id}` : `/${CRM_ROOT}/${workspace}/segments`

export const tasksPath = (workspace: string, params: { filter?: string } = {}): string =>
  `/${CRM_ROOT}/${workspace}/tasks${query(params)}`

/** The shared inbox. Every filter is in the address, so a filtered view pastes
 *  into Slack and the back button works. */
export const inboxPath = (
  workspace: string,
  params: {
    scope?: string | undefined
    mailbox?: string | undefined
    unreplied?: string | undefined
    unread?: string | undefined
    q?: string | undefined
  } = {},
): string => `/${CRM_ROOT}/${workspace}/inbox${query(params)}`

export const threadPath = (workspace: string, threadId: string): string =>
  `/${CRM_ROOT}/${workspace}/inbox/${threadId}`

/** Sequences live in the CRM tree, not settings: they are outreach salespeople
 *  run, not configuration an admin sets once. */
export const sequencesPath = (workspace: string): string => `/${CRM_ROOT}/${workspace}/sequences`

export const sequencePath = (workspace: string, id: string): string =>
  `/${CRM_ROOT}/${workspace}/sequences/${id}`

export const enrollmentsPath = (workspace: string, id: string, params: { state?: string | undefined } = {}): string =>
  `/${CRM_ROOT}/${workspace}/sequences/${id}/enrollments${query(params)}`

/** Where sequence pixels and click redirects are served from. */
export const trackingPath = (): string => '/settings/tracking'

/** Booking sits under its own root, the way HubSpot puts scheduling pages under
 *  /meetings/:portalId rather than inside the contacts app. Same rule as everything
 *  else: the workspace is in the path, so any screen pastes. */
export const MEETINGS_ROOT = 'meetings'

export const bookingPagesPath = (workspace: string, id?: string): string =>
  id ? `/${MEETINGS_ROOT}/${workspace}/pages/${id}` : `/${MEETINGS_ROOT}/${workspace}/pages`

export const bookedPath = (
  workspace: string,
  params: { when?: 'upcoming' | 'past'; page?: string; host?: string; state?: string } = {},
): string => `/${MEETINGS_ROOT}/${workspace}/booked${query(params)}`

/** A person's own working hours, and an admin looking at somebody else's. The user
 *  is a query parameter rather than a path segment because the default subject is
 *  always "me", and a link with nobody named still opens on the right person. */
export const availabilityPath = (workspace: string, params: { user?: string; month?: string } = {}): string =>
  `/${MEETINGS_ROOT}/${workspace}/availability${query(params)}`

export const calendarsPath = (workspace: string): string =>
  `/${MEETINGS_ROOT}/${workspace}/calendars`

/** The public booking page. Absolute elsewhere; relative here because the app
 *  links to it too, from the page editor's preview. */
export const bookingPublicPath = (
  workspaceSlug: string,
  slug: string,
  params: {
    month?: string | undefined
    date?: string | undefined
    tz?: string | undefined
    slot?: string | undefined
    /** Round-trip state for the no-JavaScript path: the confirmation, the instant
     *  confirmed, the attendee's own manage tokens, a message, and per-field
     *  errors. All in the URL because a plain form post has nowhere else to put
     *  them and a redirect is what stops a refresh booking twice. */
    confirmed?: string | undefined
    at?: string | undefined
    r?: string | undefined
    c?: string | undefined
    e?: string | undefined
    err?: string | undefined
    /** A non-fatal note on an otherwise successful booking, such as a joining
     *  link that is still being created. */
    w?: string | undefined
  } = {},
): string => `/b/${workspaceSlug}/${slug}${query(params)}`

export const bookingManagePath = (purpose: 'cancel' | 'reschedule', token: string): string =>
  `/b/manage/${purpose}/${token}`

/** The meeting as a calendar file. Addressed by the reschedule token because it is
 *  the credential the attendee already holds, and it grants nothing the manage page
 *  behind the same token does not already show. */
export const bookingIcsPath = (token: string): string => `/b/ics/${token}.ics`

/** Settings has no workspace segment: a person belongs to one at a time and the
 *  switcher in the shell is what moves them. Kept as functions anyway so the day
 *  that changes is one edit here. */
export const agentAccessPath = (): string => '/settings/agent'

/** The signed-in person's own screen: identity, roles, timezone, connected Google services, sessions. */
export const accountPath = (): string => '/settings/account'

export const failedJobsPath = (): string => '/settings/jobs'

/** The company above this workspace: its workspaces, its seats, its history. */
export const organisationPath = (): string => '/settings/organisation'

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
