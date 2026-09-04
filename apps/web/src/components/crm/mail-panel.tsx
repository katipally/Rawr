'use client'

import type { EmailEngagement, ThreadMessage, ThreadSummary } from '@rawr/db'
import { Button, Spinner } from '@rawr/ui'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatDate } from './value.tsx'

export type MailPanelProps = {
  contactName: string
  threads: ThreadSummary[]
  /** The four derived numbers, so the panel says where the conversation stands
   *  before anyone opens a thread. */
  engagement: EmailEngagement
}

/** F1 phase B, the thing the feature exists for: a successor opens a contact and
 *  reads the correspondence without anybody having forwarded anything.
 *
 *  Threads are listed from what the sync stored. Opening one loads its messages;
 *  opening a message fetches its body from Gmail on the spot, because bodies are
 *  kept by reference and never copied into this database. */
export const MailPanel = ({ contactName, threads, engagement }: MailPanelProps) => (
  <section className="rounded-panel border border-line bg-surface">
    <header className="border-b border-divider px-3 py-2">
      <h3 className="font-medium">Email ({threads.length})</h3>
    </header>

    {engagement.lastContactedAt || engagement.lastRepliedAt ? (
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-b border-divider px-3 py-2 text-small">
        <dt className="text-secondary">Last contacted</dt>
        <dd className="tabular-nums">{engagement.lastContactedAt ? formatDate(engagement.lastContactedAt) : '—'}</dd>
        <dt className="text-secondary">Last reply</dt>
        <dd className="tabular-nums">{engagement.lastRepliedAt ? formatDate(engagement.lastRepliedAt) : 'Never'}</dd>
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
      <p className="px-3 py-3 text-secondary">
        No threads with {contactName}. Mail appears here once somebody who has corresponded with
        them connects their mailbox, and only for threads that are not internal, personal or
        excluded.
      </p>
    ) : (
      <ul className="flex flex-col">
        {threads.map((thread) => (
          <ThreadRow key={thread.id} thread={thread} />
        ))}
      </ul>
    )}
  </section>
)

type Loaded = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; messages: ThreadMessage[] }

const ThreadRow = ({ thread }: { thread: ThreadSummary }) => {
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
        className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-fill-hover"
      >
        <span className="break-words font-medium">{thread.subject ?? '(no subject)'}</span>
        <span className="text-small text-secondary tabular-nums">
          {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}
          {thread.lastAt ? ` · last ${formatDate(new Date(thread.lastAt).toISOString())}` : ''}
        </span>
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-divider bg-fill px-3 py-2">
          {loaded.state === 'loading' ? <Spinner /> : null}
          {loaded.state === 'error' ? (
            <p role="alert" className="text-small text-error">
              {loaded.message}
            </p>
          ) : null}
          {loaded.state === 'ready'
            ? loaded.messages.map((message) => <MessageRow key={message.id} message={message} />)
            : null}
        </div>
      ) : null}
    </li>
  )
}

type Body = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; text: string; truncated: boolean }

const MessageRow = ({ message }: { message: ThreadMessage }) => {
  const [body, setBody] = useState<Body>({ state: 'idle' })

  const load = async () => {
    setBody({ state: 'loading' })
    try {
      const result = await api.mail.body.query({ messageId: message.id })
      setBody({ state: 'ready', text: result.text, truncated: result.truncated })
    } catch (cause) {
      setBody({ state: 'error', message: errorMessage(cause) })
    }
  }

  return (
    <article className="rounded-hs border border-line bg-surface px-3 py-2">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-small">
        <span className="min-w-0 break-all font-medium">
          {message.direction === 'outbound' ? 'To ' : 'From '}
          {message.direction === 'outbound' ? message.toAddrs.join(', ') || '(nobody)' : (message.fromAddr ?? '(unknown)')}
        </span>
        <time className="text-secondary tabular-nums" dateTime={new Date(message.sentAt).toISOString()}>
          {new Date(message.sentAt).toLocaleString()}
        </time>
      </header>
      {message.ccAddrs.length > 0 ? (
        <p className="text-small text-secondary break-all">cc {message.ccAddrs.join(', ')}</p>
      ) : null}

      {body.state === 'ready' ? (
        <pre className="mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words font-[inherit] text-body">
          {body.text}
          {body.truncated ? '\n\n[This message was longer than can be shown here. Open it in Gmail for the rest.]' : ''}
        </pre>
      ) : (
        <p className="mt-1 break-words text-secondary">{message.snippet ?? '(no preview)'}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-small">
        {body.state === 'idle' && message.bodyAvailable ? (
          <Button variant="tertiary" onClick={() => void load()}>
            Read full message
          </Button>
        ) : null}
        {body.state === 'idle' && !message.bodyAvailable ? (
          <span className="text-secondary">
            Only the preview is available: the mailbox that read this message is no longer connected.
          </span>
        ) : null}
        {body.state === 'loading' ? <Spinner /> : null}
        {body.state === 'error' ? (
          <span role="alert" className="text-error">
            {body.message}
          </span>
        ) : null}
        {message.hasAttachments ? <span className="text-secondary">Has attachments (open in Gmail)</span> : null}
      </div>
    </article>
  )
}
