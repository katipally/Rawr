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

export const workspaceHome = (workspace: string): string =>
  objectView(workspace, 'contact', 'all', 'list')

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

export const importsPath = (workspace: string, id?: string): string =>
  id ? `/${CRM_ROOT}/${workspace}/import/${id}` : `/${CRM_ROOT}/${workspace}/import`

export const tasksPath = (workspace: string, params: { filter?: string } = {}): string =>
  `/${CRM_ROOT}/${workspace}/tasks${query(params)}`

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
