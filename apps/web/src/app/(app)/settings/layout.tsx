import type { ReactNode } from 'react'
import { SettingsNav, type SettingsGroup } from './nav.tsx'
import {
  accountPath,
  agentAccessPath,
  auditPath,
  failedJobsPath,
  integrationsPath,
  lifecyclePath,
  mailboxesPath,
  membersPath,
  organisationPath,
  pipelinesPath,
  propertiesPath,
  sitesPath,
  subscriptionsPath,
  teamsPath,
} from '~/lib/links.ts'

/** One place that knows what settings there are. Each page used to link to two or
 *  three of the others by hand, which meant a new page was reachable only from
 *  whichever page somebody remembered to edit.
 *
 *  Grouped the way HubSpot groups them: what is yours, who is here, what shape the
 *  data takes, and what is plugged in. Eleven flat entries were a wall. */
const GROUPS: SettingsGroup[] = [
  {
    label: 'Your preferences',
    sections: [
      { href: accountPath(), label: 'Your account', hint: 'Who you are, your timezone, your connections' },
      { href: agentAccessPath(), label: 'Agent access', hint: 'Connecting Claude and other assistants' },
    ],
  },
  {
    label: 'Account management',
    sections: [
      { href: organisationPath(), label: 'Organisation', hint: 'Workspaces, seats and how people get in' },
      { href: membersPath(), label: 'Members', hint: 'Who is here, and what each of them may do' },
      { href: teamsPath(), label: 'Teams', hint: 'Groups that assignment rotates within' },
      { href: auditPath(), label: 'History', hint: 'Who changed what, and when' },
    ],
  },
  {
    label: 'Data management',
    sections: [
      { href: propertiesPath(), label: 'Properties', hint: 'The fields on every record' },
      { href: pipelinesPath(), label: 'Pipelines', hint: 'Deal stages and probabilities' },
      { href: lifecyclePath(), label: 'Lifecycle', hint: 'The ordered stage list' },
      { href: subscriptionsPath(), label: 'Subscriptions', hint: 'What people can opt out of' },
      { href: mailboxesPath(), label: 'Mailboxes', hint: 'Gmail history on records' },
      { href: sitesPath(), label: 'Tracked sites', hint: 'Hosts that may send events' },
    ],
  },
  {
    label: 'Tools',
    sections: [
      { href: integrationsPath(), label: 'Integrations', hint: 'Connected services and their health' },
      { href: failedJobsPath(), label: 'Failed jobs', hint: 'What broke, and replaying it' },
    ],
  },
]

const SettingsLayout = ({ children }: { children: ReactNode }) => (
  // One column on a phone, a rail beside the content once there is room for it.
  <div className="grid gap-6 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
    <SettingsNav groups={GROUPS} />
    <div className="min-w-0">{children}</div>
  </div>
)

export default SettingsLayout
