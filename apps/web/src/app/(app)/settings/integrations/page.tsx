import { redirect } from 'next/navigation'
import { webhooksPath } from '~/lib/links.ts'

const IntegrationsPage = () => redirect(webhooksPath())

export default IntegrationsPage
