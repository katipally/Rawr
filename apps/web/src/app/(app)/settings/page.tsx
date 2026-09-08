import { redirect } from 'next/navigation'
import { accountPath } from '~/lib/links.ts'

/** /settings on its own is what somebody types, and what the gear links to. It
 *  opens the person's own screen rather than an account-wide one, because that
 *  is the only settings page every role can act on. */
const SettingsIndex = () => redirect(accountPath())

export default SettingsIndex
