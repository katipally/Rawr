import { redirect } from 'next/navigation'
import { accountHome } from '~/lib/links.ts'
import { readSession } from '~/server/session.ts'

/** A shortened address lands on the account's front door, not on a page without a frame. */
const ContactsRoot = async () => {
  const session = await readSession()
  redirect(session ? accountHome(session.accountSlug) : '/sign-in')
}

export default ContactsRoot
