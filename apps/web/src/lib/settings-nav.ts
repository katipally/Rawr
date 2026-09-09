import {
  accountPath,
  agentAccessPath,
  auditPath,
  automationsPath,
  calendarsPath,
  defaultsPath,
  failedJobsPath,
  integrationsPath,
  lifecyclePath,
  mailboxesPath,
  membersPath,
  objectsPath,
  pipelinesPath,
  propertiesPath,
  sitesPath,
  subscriptionsPath,
  teamsPath,
  trackingPath,
} from './links.ts'

export type SettingsSection = { href: string; label: string; keywords?: string[] }
export type SettingsGroup = { label: string; sections: SettingsSection[] }

/** One place that knows what settings there are. Each page used to link to two or
 *  three of the others by hand, which meant a new page was reachable only from
 *  whichever page somebody remembered to edit.
 *
 *  Grouped the way HubSpot groups them: what is yours, who is here, what shape the
 *  data takes, and what is plugged in. Eleven flat entries were a wall.
 *
 *  Names only. What each page is for is the sentence under its own title, where
 *  it is read once by whoever opened it, rather than sixteen times in the rail.
 *
 *  `keywords` are for the top bar, not the rail: the word somebody types is often
 *  HubSpot's or their own rather than ours, and "billing" finding nothing is
 *  indistinguishable from the page not existing. */
export const settingsGroups = (account: string): SettingsGroup[] => [
  {
    label: 'Your preferences',
    sections: [
      { href: accountPath(), label: 'Your account', keywords: ['profile', 'me', 'sign out'] },
      { href: agentAccessPath(), label: 'Agent access', keywords: ['mcp', 'api', 'token', 'assistant', 'claude'] },
    ],
  },
  {
    label: 'Account management',
    sections: [
      { href: defaultsPath(), label: 'Account Defaults', keywords: ['currency', 'timezone', 'locale'] },
      { href: membersPath(), label: 'Users', keywords: ['members', 'people', 'seats', 'invite', 'permissions', 'roles'] },
      { href: teamsPath(), label: 'Teams', keywords: ['groups', 'assignment'] },
      { href: auditPath(), label: 'History', keywords: ['audit', 'log', 'who changed'] },
    ],
  },
  {
    label: 'Data management',
    sections: [
      { href: objectsPath(), label: 'Objects', keywords: ['data model', 'schema', 'custom objects'] },
      { href: propertiesPath(), label: 'Properties', keywords: ['fields', 'columns', 'attributes'] },
      { href: pipelinesPath(), label: 'Pipelines', keywords: ['stages', 'deal stages'] },
      { href: lifecyclePath(), label: 'Lifecycle', keywords: ['stages', 'lead', 'customer'] },
      { href: subscriptionsPath(), label: 'Subscriptions', keywords: ['billing', 'unsubscribe', 'consent', 'opt out'] },
      { href: mailboxesPath(), label: 'Mailboxes', keywords: ['gmail', 'email', 'inbox', 'connect'] },
      // Which Google accounts Rawr may read free-busy from. It sat in the Sales
      // rail under "Calendar", where people opened it looking for a month.
      { href: calendarsPath(account), label: 'Calendar connections', keywords: ['google calendar', 'availability'] },
      { href: sitesPath(), label: 'Tracked sites', keywords: ['analytics', 'tracking', 'website', 'pixel'] },
    ],
  },
  {
    label: 'Tools',
    sections: [
      { href: automationsPath(), label: 'Automations', keywords: ['workflows', 'rules', 'triggers'] },
      { href: integrationsPath(), label: 'Integrations', keywords: ['apps', 'connect', 'apollo', 'brevo', 'slack', 'webhooks'] },
      { href: trackingPath(), label: 'Tracking domain', keywords: ['cname', 'links', 'open tracking'] },
      { href: failedJobsPath(), label: 'Failed jobs', keywords: ['queue', 'errors', 'dead letters'] },
    ],
  },
]
