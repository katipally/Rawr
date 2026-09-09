'use client'

import { Bell, Trash2, Undo2 } from 'lucide-react'
import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Drawer, EmptyState, IconButton, Spinner, cn } from '@rawr/ui'
import type { NotificationCursor, NotificationRow, NotificationTab } from '@rawr/db'
import { formatDateTime } from '~/components/crm/value.tsx'
import { mailboxesPath, recordPath, submissionsPath, tasksPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useZone } from '~/components/zone.tsx'

/** How stale the badge may get. Long enough that moving around the app is not a
 *  request per page; short enough that clearing a queue shows while the person is
 *  still looking at it. */
const REFRESH_MS = 60_000

const TABS: { key: NotificationTab; label: string }[] = [
  { key: 'unread', label: 'Unread' },
  { key: 'all', label: 'All' },
  { key: 'trash', label: 'Trash' },
]

type Row = Omit<NotificationRow, 'readAt' | 'trashedAt' | 'at'> & {
  readAt: string | null
  trashedAt: string | null
  at: string
}

/** Where a notice takes you. Built here rather than stored, so a route that
 *  changes does not leave a table full of dead links. */
const hrefFor = (row: Row, account: string): string | null => {
  if (row.entity && row.entityId) return recordPath(account, row.entity, row.entityId)
  if (row.kind === 'task_overdue') return tasksPath(account)
  if (row.kind === 'form_quarantined') return submissionsPath(account, { state: 'quarantined' })
  if (row.kind === 'form_submission') return submissionsPath(account)
  if (row.kind === 'mailbox_revoked') return mailboxesPath()
  return null
}

export const NotificationBell = ({ accountSlug }: { accountSlug: string }) => {
  const zone = useZone()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<NotificationTab>('unread')
  const [count, setCount] = useState(0)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [cursor, setCursor] = useState<NotificationCursor | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  const refreshCount = useCallback(() => {
    api.notifications.unreadCount
      .query()
      .then(setCount)
      .catch(() => {
        // A failed poll is not worth a message: the next one is a minute away and
        // the drawer says so properly if it is opened.
      })
  }, [])

  useEffect(() => {
    refreshCount()
    const timer = window.setInterval(refreshCount, REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [refreshCount])

  const load = useCallback(
    (which: NotificationTab, after: NotificationCursor | null) => {
      setBusy(true)
      setError(null)
      api.notifications.list
        .query({ tab: which, cursor: after, limit: 30 })
        .then((page) => {
          const next = page.rows.map((row) => ({
            ...row,
            readAt: row.readAt ? row.readAt.toISOString() : null,
            trashedAt: row.trashedAt ? row.trashedAt.toISOString() : null,
            at: row.at.toISOString(),
          }))
          setRows((current) => (after && current ? [...current, ...next] : next))
          setCursor(page.nextCursor)
        })
        .catch((cause) => setError(errorMessage(cause)))
        .finally(() => setBusy(false))
    },
    [],
  )

  // Opening, and switching tab while open, are the same request. pathname is not
  // involved: the drawer is the shell's, and survives navigation on purpose.
  useEffect(() => {
    if (!open) return
    setRows(null)
    load(tab, null)
  }, [open, tab, load])

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn()
      refreshCount()
      setRows(null)
      load(tab, null)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  return (
    <>
      <span className="relative inline-flex">
        <IconButton
          ref={trigger}
          label={count > 0 ? `Notifications, ${count} unread` : 'Notifications'}
          icon={<Bell className="size-4" />}
          className="text-nav-text hover:bg-nav-hover"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        />
        {count > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-pill bg-brand px-1 text-[0.625rem] font-medium leading-4 text-white"
          >
            {count >= 100 ? '99+' : count}
          </span>
        ) : null}
      </span>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="Notifications"
      >
        {/* Buttons, not the Tabs primitive: that one is deliberately
            address-driven and holds no state, and a drawer is not a route. */}
        <div role="tablist" aria-label="Notifications" className="flex shrink-0 gap-1 border-b border-divider px-4">
          {TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={tab === entry.key}
              onClick={() => setTab(entry.key)}
              className={cn(
                'min-h-10 border-b-2 px-3 font-medium',
                tab === entry.key ? 'border-body text-body' : 'border-transparent text-secondary hover:text-body',
              )}
            >
              {entry.label}
              {entry.key === 'unread' && count > 0 ? ` (${count >= 100 ? '99+' : count})` : ''}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error ? <p className="p-4 text-error">{error}</p> : null}
          {rows === null && busy ? (
            <div className="p-4">
              <Spinner label="Loading notifications" />
            </div>
          ) : null}

          {rows !== null && rows.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={
                  tab === 'trash' ? 'Nothing in the trash' : "You don't have any notifications"
                }
                description={
                  tab === 'trash'
                    ? 'Anything you throw away lands here for thirty days.'
                    : 'But as soon as something happens, you will find it right here.'
                }
              />
            </div>
          ) : null}

          <ul className="flex flex-col">
            {(rows ?? []).map((row) => {
              const href = hrefFor(row, accountSlug)
              const unread = row.readAt === null
              return (
                <li
                  key={row.id}
                  className={cn(
                    'flex items-start gap-2 border-b border-divider px-4 py-3',
                    unread && 'bg-fill',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-pill',
                      unread ? 'bg-brand' : 'bg-transparent',
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    {href ? (
                      <Link
                        href={href}
                        onClick={() => {
                          setOpen(false)
                          if (unread) void act(() => api.notifications.markRead.mutate({ id: row.id }))
                        }}
                        className="font-medium text-body no-underline hover:underline"
                      >
                        {row.title}
                      </Link>
                    ) : (
                      <span className="font-medium">{row.title}</span>
                    )}
                    {row.body ? <span className="text-secondary">{row.body}</span> : null}
                    <span className="text-small text-secondary">
                      {formatDateTime(row.at, zone)}
                      {row.count > 1 ? ` · ${row.count} times` : ''}
                    </span>
                  </span>
                  <span className="shrink-0">
                    {row.trashedAt ? (
                      <IconButton
                        label={`Restore ${row.title}`}
                        icon={<Undo2 className="size-4" />}
                        onClick={() => void act(() => api.notifications.restore.mutate({ id: row.id }))}
                      />
                    ) : (
                      <IconButton
                        label={`Throw away ${row.title}`}
                        icon={<Trash2 className="size-4" />}
                        onClick={() => void act(() => api.notifications.trash.mutate({ id: row.id }))}
                      />
                    )}
                  </span>
                </li>
              )
            })}
          </ul>

          {cursor ? (
            <div className="p-4">
              <Button busy={busy} onClick={() => load(tab, cursor)}>
                Show older
              </Button>
            </div>
          ) : null}
        </div>

        {count > 0 && tab !== 'trash' ? (
          <footer className="shrink-0 border-t border-divider p-3">
            <Button onClick={() => void act(() => api.notifications.markAllRead.mutate())}>
              Mark all as read
            </Button>
          </footer>
        ) : null}
      </Drawer>
    </>
  )
}
