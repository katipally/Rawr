'use client'

import type { EmailEngagement, ThreadMessage, ThreadSummary } from '@rawr/db'
import { Spinner } from '@rawr/ui'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { MessageView } from './message-view.tsx'
import { formatDate } from './value.tsx'

export type MailPanelProps = {
  /** The reader's zone, from the page's session. */
  zone: string
  contactName: string
  threads: ThreadSummary[]
  /** The four derived numbers, so the panel says where the conversation stands
   *  before anyone opens a thread. */
  engagement: EmailEngagement
}

/** The thing the feature exists for: a successor opens a contact and reads the
 *  correspondence without anybody having forwarded anything.
 *
 *  Threads and their bodies are read from here, not from Gmail, so the history
 *  outlives the mailbox that brought it in. Which threads are visible is decided
 *  by each mailbox's own sharing setting, in SQL. */
export const MailPanel = ({ contactName, threads, engagement, zone }: MailPanelProps) => (
  <section className="rounded-panel border border-line bg-surface shadow-panel">
    <header className="px-6 pt-6 pb-4">
      <h2 className="text-base font-semibold">Email ({threads.length})</h2>
    </header>

    {engagement.lastContactedAt || engagement.lastRepliedAt ? (
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-b border-divider px-6 py-2 text-small">
        <dt className="text-secondary">Last contacted</dt>
        <dd className="tabular-nums">{engagement.lastContactedAt ? formatDate(engagement.lastContactedAt, zone) : '—'}</dd>
        <dt className="text-secondary">Last reply</dt>
        <dd className="tabular-nums">{engagement.lastRepliedAt ? formatDate(engagement.lastRepliedAt, zone) : 'Never'}</dd>
        <dt className="text-secondary">Sent · received</dt>
        <dd className="tabular-nums">
          {engagement.emailsSent} · {engagement.emailsReceived}
        </dd>
        {engagement.awaitingReplyDays !== null ? (
          <dd className={`col-span-2 ${engagement.awaitingReplyDays >= 7 ? 'text-warning' : 'text-secondary'}`}>
            {engagement.awaitingReplyDays === 0
              ? 'Contacted today, no reply yet.'
              : `Waiting on a reply for ${engagement.awaitingReplyDays} day${engagement.awaitingReplyDays === 1 ? '' : 's'}.`}
          </dd>
        ) : null}
      </dl>
    ) : null}

    {threads.length === 0 ? (
      <p className="px-6 py-3 text-secondary">
        No threads with {contactName}. Mail appears here once somebody who has corresponded with
        them connects their mailbox, and only for threads that are not internal, personal or
        excluded.
      </p>
    ) : (
      <ul className="flex flex-col">
        {threads.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} zone={zone} />
        ))}
      </ul>
    )}
  </section>
)

type Loaded = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; messages: ThreadMessage[] }

const ThreadRow = ({ thread, zone }: { thread: ThreadSummary; zone: string }) => {
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'idle' })

  const toggle = async () => {
    const next = !open
    setOpen(next)
    if (!next || loaded.state === 'ready' || loaded.state === 'loading') return
    setLoaded({ state: 'loading' })
    try {
      const result = await api.mail.thread.query({ id: thread.id })
      setLoaded({ state: 'ready', messages: result?.messages ?? [] })
    } catch (cause) {
      setLoaded({ state: 'error', message: errorMessage(cause) })
    }
  }

  return (
    <li className="border-b border-divider last:border-0">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex w-full flex-col items-start gap-0.5 px-6 py-2 text-left hover:bg-fill-hover"
      >
        <span className="break-words font-medium">{thread.subject ?? '(no subject)'}</span>
        <span className="text-small text-secondary tabular-nums">
          {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}
          {thread.lastAt ? ` · last ${formatDate(new Date(thread.lastAt).toISOString(), zone)}` : ''}
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-divider bg-fill px-6 py-2">
          {loaded.state === 'loading' ? <Spinner /> : null}
          {loaded.state === 'error' ? (
            <p role="alert" className="text-small text-error">
              {loaded.message}
            </p>
          ) : null}
          {loaded.state === 'ready'
            ? loaded.messages.map((message) => <MessageView key={message.id} message={message} />)
            : null}
        </div>
      ) : null}
    </li>
  )
}
