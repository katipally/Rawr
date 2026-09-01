import type { ReactNode } from 'react'
import { SettingsNav } from './nav.tsx'
import {
  agentAccessPath,
  failedJobsPath,
  integrationsPath,
  lifecyclePath,
  mailboxesPath,
  pipelinesPath,
  propertiesPath,
  sitesPath,
  subscriptionsPath,
} from '~/lib/links.ts'

/** One place that knows what settings there are. Each page used to link to two or
 *  three of the others by hand, which meant a new page was reachable only from
 *  whichever page somebody remembered to edit. */
const SECTIONS = [
  { href: propertiesPath(), label: 'Properties', hint: 'The fields on every record' },
  { href: pipelinesPath(), label: 'Pipelines', hint: 'Deal stages and probabilities' },
  { href: lifecyclePath(), label: 'Lifecycle', hint: 'The ordered stage list' },
  { href: subscriptionsPath(), label: 'Subscriptions', hint: 'What people can opt out of' },
  { href: mailboxesPath(), label: 'Mailboxes', hint: 'Gmail history on records' },
  { href: integrationsPath(), label: 'Integrations', hint: 'Connected services and their health' },
  { href: sitesPath(), label: 'Tracked sites', hint: 'Hosts that may send events' },
  { href: agentAccessPath(), label: 'Agent access', hint: 'Tokens for Claude' },
  { href: failedJobsPath(), label: 'Failed jobs', hint: 'What broke, and replaying it' },
]

const SettingsLayout = ({ children }: { children: ReactNode }) => (
  // One column on a phone, a rail beside the content once there is room for it.
  <div className="grid gap-6 lg:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
    <SettingsNav sections={SECTIONS} />
    <div className="min-w-0">{children}</div>
  </div>
)

export default SettingsLayout
