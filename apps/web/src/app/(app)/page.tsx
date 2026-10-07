import { redirect } from 'next/navigation'
import { accountHome } from '~/lib/links.ts'
import { NOTICE_PARAM, noticeFor } from '~/lib/notices.ts'
import { readSession } from '~/server/session.ts'

/** The front door is the account home. Every CRM address
 *  carries its account, so the redirect has to read the session to build one.
 *  A notice carried here by the account switch is passed on rather than dropped,
 *  otherwise a link into an account you cannot open bounces you silently. */
const Home = async ({ searchParams }: { searchParams: Promise<{ notice?: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')
  const { notice } = await searchParams
  const home = accountHome(session.accountSlug)
  redirect(noticeFor(notice) ? `${home}?${NOTICE_PARAM}=${notice}` : home)
}

export default Home
