import type { ThreadSummary } from '@rawr/db'
import { formatDate } from './value.tsx'

export type MailPanelProps = {
  contactName: string
  threads: ThreadSummary[]
}

/** F1 phase B, the thing the feature exists for: a successor opens a contact and
 *  reads the correspondence without anybody having forwarded anything.
 *
 *  Subject, dates and counts only. Bodies are stored by reference and are not
 *  rendered here; the timeline entry each thread wrote carries the snippet. */
export const MailPanel = ({ contactName, threads }: MailPanelProps) => (
  <section className="rounded-panel border border-line bg-surface">
    <header className="border-b border-divider px-3 py-2">
      <h3 className="font-medium">Email ({threads.length})</h3>
    </header>

    {threads.length === 0 ? (
      <p className="px-3 py-3 text-secondary">
        No threads with {contactName}. Mail appears here once somebody who has corresponded with
        them connects their mailbox, and only for threads that are not internal, personal or
        excluded.
      </p>
    ) : (
      <ul className="flex flex-col">
        {threads.map((thread) => (
          <li key={thread.id} className="border-b border-divider px-3 py-2 last:border-0">
            <p className="break-words font-medium">{thread.subject ?? '(no subject)'}</p>
            <p className="text-small text-secondary tabular-nums">
              {thread.messageCount} message{thread.messageCount === 1 ? '' : 's'}
              {thread.lastAt ? ` · last ${formatDate(thread.lastAt.toISOString())}` : ''}
            </p>
          </li>
        ))}
      </ul>
    )}
  </section>
)
