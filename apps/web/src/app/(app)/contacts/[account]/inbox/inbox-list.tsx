'use client'

import { Avatar, Badge, Button, EmptyState, Spinner, cn, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useState } from 'react'
import { threadPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import type { InboxFilters } from './inbox-frame.tsx'

type Thread = {
  id: string
  subject: string | null
  lastAt: string | null
  messageCount: number
  lastDirection: 'inbound' | 'outbound' | null
  lastFrom: string | null
  snippet: string | null
  unread: boolean
  contacts: { id: string; name: string }[]
  mailboxEmails: string[]
}

type Cursor = { lastAt: string; id: string } | null

/** Who a thread is with, the way HubSpot heads each row: the contact if one is
 *  linked, else the newest sender's address. */
const whoOf = (thread: Thread): string => thread.contacts[0]?.name ?? thread.lastFrom ?? 'Unknown sender'

/** The middle pane: newest first, the open one marked, older pages fetched in
 *  place so the scroll position survives. */
export const InboxList = ({
  account,
  initial,
  cursor: initialCursor,
  filters,
  selected,
}: {
  account: string
  initial: Thread[]
  cursor: Cursor
  filters: InboxFilters
  selected: string | null
}) => {
  const toast = useToast()
  const [threads, setThreads] = useState(initial)
  const [cursor, setCursor] = useState<Cursor>(initialCursor)
  const [busy, setBusy] = useState(false)

  const more = async () => {
    if (!cursor) return
    setBusy(true)
    try {
      const page = await api.mail.inbox.query({ ...filters, cursor, limit: 25 })
      setThreads((current) => [
        ...current,
        ...page.threads.map((thread) => ({ ...thread, lastAt: thread.lastAt?.toISOString() ?? null })),
      ])
      setCursor(page.cursor)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={cn(
        'flex w-full shrink-0 flex-col border-r border-line bg-surface md:w-[19.75rem]',
        // On a phone the list and the conversation take turns: the list until a
        // thread is opened, then the conversation.
        selected && 'hidden md:flex',
      )}
    >
      <p className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4 text-small">
        <span className="text-secondary">{filters.q ? `Matching “${filters.q}”` : 'Newest first'}</span>
        <span className="font-semibold">{threads.length.toLocaleString()}{cursor ? '+' : ''}</span>
      </p>

      {threads.length === 0 ? (
        <EmptyState
          title="No threads match"
          description="Pick another view, or connect a mailbox under Inbox Settings. Internal, personal and excluded threads are never stored."
        />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {threads.map((thread) => {
            const open = thread.id === selected
            return (
              <li key={thread.id}>
                <Link
                  href={threadPath(account, thread.id)}
                  aria-current={open ? 'page' : undefined}
                  className={cn(
                    'flex gap-3 border-b border-line border-l-[3px] px-4 py-3 no-underline hover:bg-fill',
                    open ? 'border-l-body bg-canvas' : 'border-l-transparent',
                  )}
                >
                  <Avatar name={whoOf(thread)} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={cn('truncate text-body', thread.unread ? 'font-semibold' : 'font-medium')}>{whoOf(thread)}</span>
                      <time className="shrink-0 text-small text-secondary tabular-nums" dateTime={thread.lastAt ?? undefined}>
                        {thread.lastAt ? new Date(thread.lastAt).toLocaleDateString() : ''}
                      </time>
                    </span>
                    <span className={cn('truncate text-body', thread.unread && 'font-semibold')}>{thread.subject ?? '(no subject)'}</span>
                    <span className="truncate text-small text-secondary">{thread.snippet ?? ''}</span>
                    {thread.lastDirection === 'inbound' ? (
                      <span className="mt-1">
                        <Badge tone="warn">Waiting on us</Badge>
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      {cursor || busy ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-line p-3">
          {cursor ? (
            <Button busy={busy} onClick={() => void more()}>
              Show older
            </Button>
          ) : null}
          {busy ? <Spinner label="Loading threads" /> : null}
        </div>
      ) : null}
    </div>
  )
}
