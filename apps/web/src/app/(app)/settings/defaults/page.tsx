import { readAccount } from '@rawr/db'
import { PageHeader } from '@rawr/ui'
import { contextFrom, readSession } from '~/server/session.ts'
import { DefaultsPanel } from './defaults-panel.tsx'

/** What the account itself is: its name, the domain it trusts, what a domain
 *  joiner arrives holding, how many seats there are and how long raw activity is
 *  kept. HubSpot files this under Account defaults, and so does Rawr. */
const DefaultsPage = async () => {
  const session = await readSession()
  if (!session) return null

  const account = await readAccount(contextFrom(session))

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Account defaults"
        lead={`Settings that apply to everyone in ${account.name}.`}
      />
      <DefaultsPanel account={account} canWrite={session.isSuperAdmin} />
    </div>
  )
}

export default DefaultsPage
