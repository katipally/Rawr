import { isUuid, readThread } from '@rawr/db'
import { Badge, Breadcrumb, Card } from '@rawr/ui'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { MessageView } from '~/components/crm/message-view.tsx'
import { ReplyButton } from './reply.tsx'
import { ThreadRead } from './thread-read.tsx'
import { inboxPath, recordPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'

/** One conversation, in full. Read from here rather than from Gmail, so it is the
 *  same thread for whoever opens it, for as long as the workspace keeps it. */
const ThreadPage = async ({ params }: { params: Promise<{ workspace: string; thread: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace, thread: threadId } = await params
  if (!isUuid(threadId)) notFound()

  const found = await readThread(contextFrom(session), threadId)
  // Not here, or every message in it belongs to a mailbox this person may not
  // read. Both answer the same way: there is no such thread for you.
  if (!found) notFound()

  const contacts = new Map<string, string>()
  for (const message of found.messages) {
    for (const address of [message.fromAddr, ...message.toAddrs, ...message.ccAddrs]) {
      if (address) contacts.set(address, address)
    }
  }

  // Who a reply goes to: whoever sent the newest inbound message, falling back to
  // whoever the newest outbound one was addressed to.
  const newest = found.messages[found.messages.length - 1]
  const replyTo =
    newest?.direction === 'inbound' ? (newest.fromAddr ?? null) : (newest?.toAddrs[0] ?? null)

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ThreadRead threadId={threadId} />

      <Breadcrumb items={[{ label: 'Inbox', href: inboxPath(workspace) }, { label: found.thread.subject ?? '(no subject)' }]} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="min-w-0 text-lg font-medium">{found.thread.subject ?? '(no subject)'}</h1>
          <Badge>
            {found.thread.messageCount} message{found.thread.messageCount === 1 ? '' : 's'}
          </Badge>
        </div>
        {replyTo ? (
          <ReplyButton threadId={threadId} to={replyTo} subject={found.thread.subject} />
        ) : null}
      </div>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <div className="flex min-w-0 flex-col gap-2">
          {found.messages.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}
        </div>

        <Card title="Everyone on this thread">
          <ul className="flex flex-col gap-1">
            {[...contacts.keys()].map((address) => (
              <li key={address} className="break-all text-secondary">
                {address}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}

export default ThreadPage
