'use client'

import { Bell } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { Badge, IconButton, Popover, Spinner } from '@rawr/ui'
import { failedJobsPath, integrationsPath, mailboxesPath, submissionsPath, tasksPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

type Summary = {
  myOverdueTasks: number
  quarantined: number
  deadLetters: number
  brokenIntegrations: number
  brokenMailboxes: number
  total: number
}

/** How stale the count may get. Long enough that moving around the app is not a
 *  request per page; short enough that clearing a queue is reflected while the
 *  person is still looking at it. */
const REFRESH_MS = 60_000

export const NotificationBell = ({ workspaceSlug }: { workspaceSlug: string }) => {
  const [open, setOpen] = useState(false)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let live = true
    const load = () => {
      api.notifications.summary
        .query()
        .then((next) => live && setSummary(next))
        .catch((cause) => live && setError(errorMessage(cause)))
    }
    load()
    const timer = window.setInterval(load, REFRESH_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [])

  const rows = summary
    ? [
        {
          key: 'tasks',
          count: summary.myOverdueTasks,
          label: 'of your tasks are overdue',
          href: tasksPath(workspaceSlug),
          tone: 'warn' as const,
        },
        {
          key: 'submissions',
          count: summary.quarantined,
          label: 'form submissions are waiting for review',
          href: submissionsPath(workspaceSlug, { state: 'quarantined' }),
          tone: 'info' as const,
        },
        {
          key: 'jobs',
          count: summary.deadLetters,
          label: 'jobs failed and can be replayed',
          href: failedJobsPath(),
          tone: 'error' as const,
        },
        {
          key: 'integrations',
          count: summary.brokenIntegrations,
          label: 'integrations last reported an error',
          href: integrationsPath(),
          tone: 'error' as const,
        },
        {
          key: 'mailboxes',
          count: summary.brokenMailboxes,
          label: 'mailboxes need reconnecting',
          href: mailboxesPath(),
          tone: 'error' as const,
        },
      ].filter((row) => row.count > 0)
    : []

  return (
    <>
      <span className="relative inline-flex">
        <IconButton
          ref={trigger}
          label={summary && summary.total > 0 ? `Notifications, ${summary.total} waiting` : 'Notifications'}
          icon={<Bell className="size-5" />}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        />
        {summary && summary.total > 0 ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-cta px-1 text-[0.625rem] font-medium leading-4 text-white"
          >
            {summary.total > 99 ? '99+' : summary.total}
          </span>
        ) : null}
      </span>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={trigger}
        label="Notifications"
        className="w-80 p-3"
      >
        <h2 className="mb-2 font-medium">Needs attention</h2>
        {error ? <p className="text-error">{error}</p> : null}
        {!summary && !error ? <Spinner label="Loading notifications" /> : null}
        {summary && rows.length === 0 ? (
          <p className="text-secondary">Nothing is waiting on you. Queues are clear.</p>
        ) : null}
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.key}>
              <Link
                href={row.href}
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 rounded-hs px-2 py-1.5 no-underline hover:bg-fill-hover"
              >
                <Badge tone={row.tone} dot>
                  {row.count}
                </Badge>
                <span className="min-w-0 flex-1 text-body">{row.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  )
}
