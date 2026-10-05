import { redirect } from 'next/navigation'
import { calendarPath } from '~/lib/links.ts'
import { readSession } from '~/server/session.ts'

const MeetingsRoot = async () => {
  const session = await readSession()
  redirect(session ? calendarPath(session.accountSlug) : '/sign-in')
}

export default MeetingsRoot
