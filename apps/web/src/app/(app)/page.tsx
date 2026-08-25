import { redirect } from 'next/navigation'
import { workspaceHome } from '~/lib/links.ts'
import { readSession } from '~/server/session.ts'

/** The front door is the contacts list, the way HubSpot's is. Every CRM address
 *  carries its workspace, so the redirect has to read the session to build one.
 *  An error carried here by the workspace switch is passed on rather than dropped,
 *  otherwise a link into a workspace you cannot open bounces you silently. */
const Home = async ({ searchParams }: { searchParams: Promise<{ error?: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')
  const { error } = await searchParams
  const home = workspaceHome(session.workspaceSlug)
  redirect(error ? `${home}?error=${encodeURIComponent(error)}` : home)
}

export default Home
