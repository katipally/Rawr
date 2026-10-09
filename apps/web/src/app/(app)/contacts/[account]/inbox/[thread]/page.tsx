import { canWrite as roleCanWrite, isUuid, listMailboxes, readThread } from '@rawr/db'
import { Alert, Card, buttonClass } from '@rawr/ui'
import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { MessageView } from '~/components/crm/message-view.tsx'
import { googleConfigured } from '~/lib/env.ts'
import { inboxPath, mailboxesPath, recordPath } from '~/lib/links.ts'
import { replyAllRecipients } from '~/lib/mail-compose.ts'
import { pickableUsers } from '~/lib/pickable-users.ts'
import { readLookups } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { AddParticipant } from './add-participant.tsx'
import { ReplyButton } from './reply.tsx'
import { ThreadActions } from './thread-actions.tsx'
import { ThreadRead } from './thread-read.tsx'
import { filtersFrom, toParams } from '../filters.ts'
import { InboxFrame } from '../inbox-frame.tsx'

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

  const ctx = contextFrom(session)
  const canWrite = roleCanWrite(ctx, 'contact')
  const [found, mailboxes, lookups] = await Promise.all([readThread(ctx, threadId), listMailboxes(ctx), readLookups(ctx)])
  // Not here, or every message in it belongs to a mailbox this person may not
  // read. Both answer the same way: there is no such thread for you.
  if (!found) notFound()
  const backHref = inboxPath(account, toParams(filters))
  // A connected mailbox is a team inbox or a colleague's, never a person to add.
  const mailboxAddresses = new Set(mailboxes.map((box) => box.email.toLowerCase()))

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
  const everyone = replyAllRecipients(
    {
      from: newest?.direction === 'inbound' ? (newest.fromAddr ?? null) : null,
      to: newest?.toAddrs ?? [],
      cc: newest?.ccAddrs ?? [],
    },
    mailboxes.map((box) => box.email),
  )
  const replyPerson = replyTo ? (byEmail.get(replyTo.toLowerCase())?.id ?? null) : null

  return (
    <InboxFrame account={account} session={session} filters={filters} selected={threadId}>
      <ThreadRead threadId={threadId} />

      <div className="flex min-h-15 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={inboxPath(account, toParams(filters))} aria-label="Back to the inbox" className="grid size-8 shrink-0 place-items-center rounded-pill text-body no-underline hover:bg-fill @2xl/inbox:hidden">
            <ChevronLeft aria-hidden="true" className="size-4" />
          </Link>
          <div className="flex min-w-0 flex-col">
            <h1 className="min-w-0 text-base font-medium">{found.thread.subject ?? '(no subject)'}</h1>
            <p className="min-w-0 truncate text-secondary">
              {found.thread.messageCount} message{found.thread.messageCount === 1 ? '' : 's'}
              {newest?.fromAddr ? ` · last from ${newest.fromAddr}` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ThreadActions
            threadId={threadId}
            folder={filters.folder}
            unread={found.thread.unread}
            assignedTo={found.thread.assignedTo}
            assignees={pickableUsers(lookups.users, found.thread.assignedTo)}
            backHref={backHref}
            canWrite={canWrite}
          />
          {replyTo && canWrite ? (
            <ReplyButton
              account={account}
              threadId={threadId}
              subject={found.thread.subject}
              sender={replyTo}
              everyone={{ to: everyone.to.join(', '), cc: everyone.cc.join(', ') }}
              personId={replyPerson}
            />
          ) : null}
        </div>
      </div>

      {found.gmailGaps.map((gap) => {
        const own = gap.userId === session.userId
        return (
          <Alert
            key={gap.id}
            tone="warning"
            className="mx-4 mt-4"
            action={
              own ? (
                <a
                  href={googleConfigured ? (gap.canSend ? '/api/auth/google/gmail?send=1' : '/api/auth/google/gmail') : mailboxesPath()}
                  className={buttonClass('primary', 'no-underline')}
                >
                  Reconnect
                </a>
              ) : undefined
            }
          >
            {own
              ? `Reconnect ${gap.email} to also change Gmail. Archive, Trash and unread still apply here.`
              : `${gap.email} cannot change Gmail yet. Its owner can reconnect it under Inbox Settings.`}
          </Alert>
        )
      })}

      <div className="grid min-h-0 min-w-0 flex-1 gap-4 overflow-y-auto bg-fill-thread p-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,var(--spacing-inbox-aside))]">
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
                  {person || !canWrite || address === session.email || mailboxAddresses.has(address.toLowerCase()) ? null : (
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
