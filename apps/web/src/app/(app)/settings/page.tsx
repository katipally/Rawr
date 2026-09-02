import { redirect } from 'next/navigation'
import { propertiesPath } from '~/lib/links.ts'

/** /settings on its own is what somebody types. It opens the first tab. */
const SettingsIndex = () => redirect(propertiesPath())

export default SettingsIndex
