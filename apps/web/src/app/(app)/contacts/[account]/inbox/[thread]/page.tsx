import { canWrite as roleCanWrite, isUuid, readThread } from '@rawr/db'
import { Badge, Card } from '@rawr/ui'
import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { MessageView } from '~/components/crm/message-view.tsx'
import { AddParticipant } from './add-participant.tsx'
import { ReplyButton } from './reply.tsx'
import { ThreadRead } from './thread-read.tsx'
import { inboxPath, recordPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { InboxFrame, filtersFrom } from '../inbox-frame.tsx'

/** One conversation, in full. Read from here rather than from Gmail, so it is the
 *  same thread for whoever opens it, for as long as the account keeps it. */
const ThreadPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; thread: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, thread: threadId } = await params
  const filters = filtersFrom(await searchParams)
  if (!isUuid(threadId)) notFound()

  const canWrite = roleCanWrite(contextFrom(session), 'contact')
  const found = await readThread(contextFrom(session), threadId)
  // Not here, or every message in it belongs to a mailbox this person may not
  // read. Both answer the same way: there is no such thread for you.
  if (!found) notFound()

  // Every address on the thread, with the contact it belongs to where there is
  // one. An address nobody in the CRM owns still shows: that is often the
  // interesting one.
  const byEmail = new Map(
    found.contacts.flatMap((person) =>
      person.email ? [[person.email.toLowerCase(), person] as const] : [],
    ),
  )
  const addresses = new Set<string>()
  for (const message of found.messages) {
    for (const address of [message.fromAddr, ...message.toAddrs, ...message.ccAddrs]) {
      if (address) addresses.add(address)
    }
  }

  // Who a reply goes to: whoever sent the newest inbound message, falling back to
  // whoever the newest outbound one was addressed to.
  const newest = found.messages[found.messages.length - 1]
  const replyTo =
    newest?.direction === 'inbound' ? (newest.fromAddr ?? null) : (newest?.toAddrs[0] ?? null)

  return (
    <InboxFrame account={account} session={session} filters={filters} selected={threadId}>
      <ThreadRead threadId={threadId} />

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link href={inboxPath(account)} aria-label="Back to the inbox" className="grid size-8 place-items-center rounded-pill text-body no-underline hover:bg-fill md:hidden">
            <ChevronLeft aria-hidden="true" className="size-4" />
          </Link>
          <h1 className="min-w-0 text-lg font-medium">{found.thread.subject ?? '(no subject)'}</h1>
          <Badge>
            {found.thread.messageCount} message{found.thread.messageCount === 1 ? '' : 's'}
          </Badge>
        </div>
        {replyTo ? (
          <ReplyButton account={account} threadId={threadId} to={replyTo} subject={found.thread.subject} />
        ) : null}
      </div>

      <div className="grid min-h-0 min-w-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]">
        <div className="flex min-w-0 flex-col gap-2">
          {found.messages.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}
        </div>

        <Card title="Everyone on this thread">
          <ul className="flex flex-col gap-1">
            {[...addresses].map((address) => {
              const person = byEmail.get(address.toLowerCase())
              return (
                <li key={address} className="flex min-w-0 flex-col">
                  {person ? (
                    <Link href={recordPath(account, 'contact', person.id)} className="truncate font-medium">
                      {person.name}
                    </Link>
                  ) : null}
                  <span className="break-all text-secondary">{address}</span>
                  {person || !canWrite || address === session.email ? null : (
                    <span className="mt-0.5">
                      <AddParticipant address={address} />
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </Card>
      </div>
    </InboxFrame>
  )
}

export default ThreadPage
