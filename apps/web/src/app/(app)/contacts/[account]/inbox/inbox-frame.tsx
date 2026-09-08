import { inboxCounts, listInboxThreads, listMailboxes } from '@rawr/db'
import { cn } from '@rawr/ui'
import { Search, Settings } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { inboxPath, mailboxesPath } from '~/lib/links.ts'
import type { Session } from '~/server/session.ts'
import { contextFrom } from '~/server/session.ts'
import { InboxList } from './inbox-list.tsx'

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

const toParams = (filters: InboxFilters) => ({
  scope: filters.scope === 'mine' ? 'mine' : undefined,
  mailbox: filters.mailboxId ?? undefined,
  unreplied: filters.unreplied ? '1' : undefined,
  unread: filters.unread ? '1' : undefined,
  q: filters.q ?? undefined,
})

/** HubSpot's inbox: three panes on the canvas. The views and mailboxes at the
 *  left, the threads that match in the middle, and the conversation, or an
 *  invitation to pick one, at the right. Every view is an address, so a
 *  filtered inbox pastes into Slack and the back button works. */
export const InboxFrame = async ({
  account,
  session,
  filters,
  selected,
  children,
}: {
  account: string
  session: Session
  filters: InboxFilters
  /** The open thread, so its row is drawn as the current one. */
  selected: string | null
  children: ReactNode
}) => {
  const ctx = contextFrom(session)
  const [page, mailboxes, counts] = await Promise.all([
    listInboxThreads(ctx, { ...filters, limit: 25 }),
    listMailboxes(ctx),
    inboxCounts(ctx),
  ])

  const views: { key: string; label: string; count: number; filters: InboxFilters }[] = [
    { key: 'all', label: 'All', count: counts.all, filters: { scope: 'all', mailboxId: null, unreplied: false, unread: false, q: null } },
    { key: 'mine', label: 'In my mailbox', count: counts.mine, filters: { scope: 'mine', mailboxId: null, unreplied: false, unread: false, q: null } },
    { key: 'unreplied', label: 'Waiting on us', count: counts.unreplied, filters: { scope: 'all', mailboxId: null, unreplied: true, unread: false, q: null } },
    { key: 'unread', label: 'Unread', count: counts.unread, filters: { scope: 'all', mailboxId: null, unreplied: false, unread: true, q: null } },
  ]
  const same = (a: InboxFilters, b: InboxFilters) =>
    a.scope === b.scope && a.mailboxId === b.mailboxId && a.unreplied === b.unreplied && a.unread === b.unread
  const current = views.find((view) => same(view.filters, filters))?.key ?? null
  const link = 'flex items-center justify-between gap-2 rounded-hs px-3 py-2 text-body no-underline hover:bg-fill'

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-[14.75rem] shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="flex flex-col gap-3 px-4 pt-4 pb-2">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <form action={inboxPath(account)} className="relative">
            {filters.scope === 'mine' ? <input type="hidden" name="scope" value="mine" /> : null}
            {filters.unreplied ? <input type="hidden" name="unreplied" value="1" /> : null}
            {filters.unread ? <input type="hidden" name="unread" value="1" /> : null}
            {filters.mailboxId ? <input type="hidden" name="mailbox" value={filters.mailboxId} /> : null}
            <input
              type="search"
              name="q"
              defaultValue={filters.q ?? ''}
              aria-label="Search threads"
              placeholder="Search"
              className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-9 pl-4 text-body placeholder:text-muted"
            />
            <Search aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
          </form>
        </div>
        <nav aria-label="Inbox views" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2">
          <ul className="flex flex-col">
            {views.map((view) => (
              <li key={view.key}>
                <Link
                  href={inboxPath(account, toParams({ ...view.filters, q: filters.q }))}
                  aria-current={current === view.key ? 'page' : undefined}
                  className={cn(link, current === view.key && 'bg-canvas font-semibold')}
                >
                  <span className="truncate">{view.label}</span>
                  <span className="shrink-0 text-small tabular-nums">{view.count.toLocaleString()}</span>
                </Link>
              </li>
            ))}
          </ul>
          {mailboxes.length > 0 ? (
            <>
              <h2 className="mt-4 px-3 pb-1 text-small font-semibold text-secondary">Mailboxes</h2>
              <ul className="flex flex-col">
                {mailboxes.map((box) => (
                  <li key={box.id}>
                    <Link
                      href={inboxPath(account, toParams({ ...filters, mailboxId: filters.mailboxId === box.id ? null : box.id }))}
                      aria-current={filters.mailboxId === box.id ? 'page' : undefined}
                      className={cn(link, filters.mailboxId === box.id && 'bg-canvas font-semibold')}
                    >
                      <span className="truncate">{box.email}</span>
                      {box.userId === session.userId ? <span className="shrink-0 text-small text-secondary">Yours</span> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </nav>
        <Link href={mailboxesPath()} className="flex items-center gap-2 border-t border-line px-4 py-3 text-body no-underline hover:bg-fill">
          <Settings aria-hidden="true" className="size-4" />
          Inbox Settings
        </Link>
      </aside>

      <InboxList
        account={account}
        initial={page.threads.map((thread) => ({ ...thread, lastAt: thread.lastAt?.toISOString() ?? null }))}
        cursor={page.cursor}
        filters={filters}
        selected={selected}
      />

      <section className="flex min-w-0 flex-1 flex-col bg-canvas">{children}</section>
    </div>
  )
}
