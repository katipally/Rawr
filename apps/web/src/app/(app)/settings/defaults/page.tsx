import { readAccount } from '@rawr/db'
import { PageHeader } from '@rawr/ui'
import { contextFrom, readSession } from '~/server/session.ts'
import { DefaultsPanel } from './defaults-panel.tsx'

/** What the account itself is: its name, the domain it trusts, what a domain
 *  joiner arrives holding, how many seats there are, how long raw activity is
 *  kept and which timezone its days are counted in and which currency its amounts default to. HubSpot files this under Account defaults, and so does Rawr. */
const DefaultsPage = async () => {
  const session = await readSession()
  if (!session) return null

  const account = await readAccount(contextFrom(session))
  // From the server's own list, so what is offered is what a save will accept,
  // with the stored zone and UTC kept in it where an engine leaves them out.
  const zones = [...new Set([account.timezone, 'UTC', ...Intl.supportedValuesOf('timeZone')])].sort()
  const currencies = [...new Set([account.currency, ...Intl.supportedValuesOf('currency')])].sort()

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Account defaults"
        lead={`Settings that apply to everyone in ${account.name}.`}
      />
      <DefaultsPanel account={account} canWrite={session.isSuperAdmin} zones={zones} currencies={currencies} />
    </div>
  )
}

export default DefaultsPage
