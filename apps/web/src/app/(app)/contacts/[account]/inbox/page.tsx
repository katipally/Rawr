import { EmptyState } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { readSession } from '~/server/session.ts'
import { InboxFrame, filtersFrom } from './inbox-frame.tsx'

/** Every thread anybody in the account may read, newest first. The shared inbox
 *  is what makes a colleague's correspondence usable rather than merely stored:
 *  the record page answers "what happened with this contact", this answers "what
 *  is happening at all, and what is waiting on us". */
const InboxPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const filters = filtersFrom(await searchParams)

  return (
    <InboxFrame account={account} session={session} filters={filters} selected={null}>
      <div className="hidden flex-1 flex-col justify-center md:flex">
        <EmptyState title="Pick a conversation" description="Bodies are kept here, so a thread outlives the mailbox that brought it in." />
      </div>
    </InboxFrame>
  )
}

export default InboxPage
