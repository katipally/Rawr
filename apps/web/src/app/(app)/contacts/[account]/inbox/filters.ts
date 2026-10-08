type Query = Record<string, string | string[] | undefined>

const one = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null)

export type InboxFilters = {
  scope: 'mine' | 'all'
  mailboxId: string | null
  unreplied: boolean
  unread: boolean
  q: string | null
}

export const filtersFrom = (query: Query): InboxFilters => ({
  scope: one(query.scope) === 'mine' ? 'mine' : 'all',
  mailboxId: one(query.mailbox),
  unreplied: one(query.unreplied) === '1',
  unread: one(query.unread) === '1',
  q: one(query.q),
})

export const toParams = (filters: InboxFilters) => ({
  scope: filters.scope === 'mine' ? 'mine' : undefined,
  mailbox: filters.mailboxId ?? undefined,
  unreplied: filters.unreplied ? '1' : undefined,
  unread: filters.unread ? '1' : undefined,
  q: filters.q ?? undefined,
})

/** A mailbox is its own source, so picking one drops "In my mailbox" rather than
 *  intersecting the two, which would be empty for anyone else's box. Picking the
 *  open mailbox again clears it. */
export const mailboxFilter = (filters: InboxFilters, mailboxId: string): InboxFilters => ({
  ...filters,
  scope: 'all',
  mailboxId: filters.mailboxId === mailboxId ? null : mailboxId,
})
