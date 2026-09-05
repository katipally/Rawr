import type { ReactNode } from 'react'
import { SettingsNav, type SettingsGroup } from './nav.tsx'
import {
  accountPath,
  agentAccessPath,
  auditPath,
  automationsPath,
  failedJobsPath,
  integrationsPath,
  lifecyclePath,
  mailboxesPath,
  membersPath,
  objectsPath,
  organisationPath,
  pipelinesPath,
  propertiesPath,
  sitesPath,
  subscriptionsPath,
  teamsPath,
  trackingPath,
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
const GROUPS: SettingsGroup[] = [
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
      { href: organisationPath(), label: 'Organisation' },
      { href: membersPath(), label: 'Members' },
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

const SettingsLayout = ({ children }: { children: ReactNode }) => (
  // One column on a phone, scrolling as one page. Once there is room for a rail
  // beside the content, the two scroll independently: the rail stays put while a
  // long settings page moves, which is the whole reason to have a rail.
  <div className="grid gap-6 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] lg:overflow-hidden">
    <div className="lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pb-4">
      <SettingsNav groups={GROUPS} />
    </div>
    <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain lg:pb-4">
      {children}
    </div>
  </div>
)

export default SettingsLayout
