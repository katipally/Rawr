import { EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { accountHome } from '~/lib/links.ts'
import { readSession } from '~/server/session.ts'

/** The proxy already redirects a link into another account through the
 *  switch handler. This is the second gate: if the slug still does not match, the
 *  person is not a member of it, and saying so beats a blank screen. */
const AccountLayout = async ({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ account: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  if (account !== session.accountSlug) {
    return (
      <EmptyState
        title={`You are not a member of “${account}”`}
        description="That link belongs to another account. Ask an admin there to add this account, or go back to your own."
        action={<Link href={accountHome(session.accountSlug)}>Open {session.accountName}</Link>}
      />
    )
  }

  return <>{children}</>
}

export default AccountLayout
