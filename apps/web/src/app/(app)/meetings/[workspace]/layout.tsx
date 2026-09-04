import { EmptyState } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { workspaceHome } from '~/lib/links.ts'
import { readSession } from '~/server/session.ts'

/** The proxy already redirects a link into another workspace through the
 *  switch handler. This is the second gate: if the slug still does not match, the
 *  person is not a member of it, and saying so beats a blank screen. */
const WorkspaceLayout = async ({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ workspace: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace } = await params
  if (workspace !== session.workspaceSlug) {
    return (
      <EmptyState
        title={`You are not a member of “${workspace}”`}
        description="That link belongs to another workspace. Ask an admin there to add this account, or go back to your own."
        action={<Link href={workspaceHome(session.workspaceSlug)}>Open {session.workspaceName}</Link>}
      />
    )
  }

  return <>{children}</>
}

export default WorkspaceLayout
