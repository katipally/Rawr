import { PageHeader } from '@rawr/ui'
import { listInboxThreads, listMailboxes } from '@rawr/db'
import { redirect } from 'next/navigation'
import { contextFrom, readSession } from '~/server/session.ts'
import { InboxList } from './inbox-list.tsx'

type Search = Record<string, string | string[] | undefined>

const one = (value: string | string[] | undefined): string | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null)

/** Every thread anybody in the workspace may read, newest first. The shared inbox
 *  is what makes a colleague's correspondence usable rather than merely stored:
 *  the record page answers "what happened with this contact", this answers "what
 *  is happening at all, and what is waiting on us". */
const InboxPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Search>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace } = await params
  const query = await searchParams
  const ctx = contextFrom(session)

  const scope = one(query.scope) === 'mine' ? 'mine' : 'all'
  const filters = {
    scope,
    mailboxId: one(query.mailbox),
    unreplied: one(query.unreplied) === '1',
    unread: one(query.unread) === '1',
    q: one(query.q),
  } as const

  const [page, mailboxes] = await Promise.all([
    listInboxThreads(ctx, { ...filters, limit: 25 }),
    listMailboxes(ctx),
  ])

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PageHeader
        title="Inbox"
        lead="Every thread the team has stored, from every shared mailbox."
        why={<p>Bodies are kept here, so a thread outlives the mailbox that brought it in.</p>}
      />

      <InboxList
        workspace={workspace}
        initial={page.threads.map((thread) => ({
          ...thread,
          lastAt: thread.lastAt?.toISOString() ?? null,
        }))}
        cursor={page.cursor}
        mailboxes={mailboxes.map((box) => ({ id: box.id, email: box.email, own: box.userId === session.userId }))}
        filters={filters}
      />
    </div>
  )
}

export default InboxPage
