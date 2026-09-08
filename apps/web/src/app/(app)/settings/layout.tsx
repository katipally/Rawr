import type { ReactNode } from 'react'
import { readSession } from '~/server/session.ts'
import { SettingsNav, type SettingsGroup } from './nav.tsx'
import {
  accountPath,
  agentAccessPath,
  auditPath,
  calendarsPath,
  automationsPath,
  failedJobsPath,
  integrationsPath,
  lifecyclePath,
  mailboxesPath,
  membersPath,
  objectsPath,
  defaultsPath,
  pipelinesPath,
  propertiesPath,
  sitesPath,
  subscriptionsPath,
  teamsPath,
  trackingPath,
  accountHome,
} from '~/lib/links.ts'

/** One place that knows what settings there are. Each page used to link to two or
 *  three of the others by hand, which meant a new page was reachable only from
 *  whichever page somebody remembered to edit.
 *
 *  Grouped the way HubSpot groups them: what is yours, who is here, what shape the
 *  data takes, and what is plugged in. Eleven flat entries were a wall.
 *
 *  Names only. What each page is for is the sentence under its own title, where
 *  it is read once by whoever opened it, rather than sixteen times in the rail. */
const groupsFor = (account: string): SettingsGroup[] => [
  {
    label: 'Your preferences',
    sections: [
      { href: accountPath(), label: 'Your account' },
      { href: agentAccessPath(), label: 'Agent access' },
    ],
  },
  {
    label: 'Account management',
    sections: [
      { href: defaultsPath(), label: 'Account Defaults' },
      { href: membersPath(), label: 'Users' },
      { href: teamsPath(), label: 'Teams' },
      { href: auditPath(), label: 'History' },
    ],
  },
  {
    label: 'Data management',
    sections: [
      { href: objectsPath(), label: 'Objects' },
      { href: propertiesPath(), label: 'Properties' },
      { href: pipelinesPath(), label: 'Pipelines' },
      { href: lifecyclePath(), label: 'Lifecycle' },
      { href: subscriptionsPath(), label: 'Subscriptions' },
      { href: mailboxesPath(), label: 'Mailboxes' },
      // Which Google accounts Rawr may read free-busy from. It sat in the Sales
      // rail under "Calendar", where people opened it looking for a month.
      { href: calendarsPath(account), label: 'Calendar connections' },
      { href: sitesPath(), label: 'Tracked sites' },
    ],
  },
  {
    label: 'Tools',
    sections: [
      { href: automationsPath(), label: 'Automations' },
      { href: integrationsPath(), label: 'Integrations' },
      { href: trackingPath(), label: 'Tracking domain' },
      { href: failedJobsPath(), label: 'Failed jobs' },
    ],
  },
]

const SettingsLayout = async ({ children }: { children: ReactNode }) => {
  const session = await readSession()
  return (
  // One column on a phone, scrolling as one page. Once there is room for a rail
  // beside the content, the two scroll independently: the rail stays put while a
  // long settings page moves, which is the whole reason to have a rail.
  <div className="grid min-h-full bg-surface lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:overflow-hidden">
    <div className="z-10 bg-surface shadow-panel lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
      <SettingsNav
        groups={groupsFor(session?.accountSlug ?? '')}
        backHref={session ? accountHome(session.accountSlug) : '/'}
      />
    </div>
    <div className="min-w-0 p-6 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
      {children}
    </div>
  </div>
  )
}

export default SettingsLayout
