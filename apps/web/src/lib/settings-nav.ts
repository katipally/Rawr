import {
  accountPath,
  agentAccessPath,
  auditPath,
  automationsPath,
  appsPath,
  defaultsPath,
  failedJobsPath,
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

export type SettingsSection = {
  href: string
  label: string
  keywords?: string[]
  /** The collapsible sub-group the entry sits under in the rail, as HubSpot
   *  folds Integrations and Tracking & Analytics. Consecutive entries share one. */
  parent?: string
  /** Other pages the entry is current on, where one entry heads a row of tabs. */
  also?: string[]
}
export type SettingsGroup = { label: string; sections: SettingsSection[] }

/** One place that knows what settings there are. Each page used to link to two or
 *  three of the others by hand, which meant a new page was reachable only from
 *  whichever page somebody remembered to edit.
 *
 *  Grouped and named the way HubSpot groups and names them: what is yours, how
 *  the account is run and what is plugged into it, what shape the data takes,
 *  and the tools. Eleven flat entries were a wall.
 *
 *  Names only. What each page is for is the sentence under its own title, where
 *  it is read once by whoever opened it, rather than sixteen times in the rail.
 *
 *  `keywords` are for the top bar, not the rail: the word somebody types is often
 *  HubSpot's or their own rather than ours, and "billing" finding nothing is
 *  indistinguishable from the page not existing. */
export const settingsGroups = (): SettingsGroup[] => [
  {
    label: 'Your Preferences',
    sections: [
      { href: accountPath(), label: 'General', keywords: ['your account', 'profile', 'me', 'sign out', 'time zone', 'sessions'] },
      { href: agentAccessPath(), label: 'Agent Access', keywords: ['mcp', 'api', 'token', 'assistant', 'claude', 'service keys', 'private apps'] },
    ],
  },
  {
    label: 'Account Management',
    sections: [
      { href: defaultsPath(), label: 'Account Defaults', keywords: ['currency', 'timezone', 'locale', 'joining'] },
      {
        href: membersPath(),
        label: 'Users & Teams',
        keywords: ['members', 'users', 'people', 'seats', 'invite', 'permissions', 'roles', 'teams', 'groups', 'assignment'],
        also: [teamsPath()],
      },
      { href: appsPath(), label: 'Connected Apps', parent: 'Integrations', keywords: ['integrations', 'apps', 'connect', 'apollo', 'brevo', 'slack', 'webhooks', 'google calendar', 'calendar connections'] },
      { href: mailboxesPath(), label: 'Mailboxes', parent: 'Integrations', keywords: ['gmail', 'email', 'inbox', 'connect'] },
      { href: sitesPath(), label: 'Tracked Sites', parent: 'Tracking & Analytics', keywords: ['analytics', 'tracking', 'website', 'pixel'] },
      { href: trackingPath(), label: 'Tracking', parent: 'Tracking & Analytics', keywords: ['tracking domain', 'cname', 'links', 'open tracking', 'events', 'campaigns', 'utm'] },
      { href: auditPath(), label: 'Audit Logs', keywords: ['audit', 'log', 'who changed', 'history'] },
    ],
  },
  {
    label: 'Data Management',
    sections: [
      { href: objectsPath(), label: 'Objects', keywords: ['data model', 'schema', 'custom objects'] },
      { href: propertiesPath(), label: 'Properties', keywords: ['fields', 'columns', 'attributes'] },
      { href: pipelinesPath(), label: 'Pipelines', keywords: ['stages', 'deal stages'] },
      { href: lifecyclePath(), label: 'Lifecycle Stages', keywords: ['stages', 'lead', 'customer'] },
      { href: subscriptionsPath(), label: 'Subscriptions', keywords: ['billing', 'unsubscribe', 'consent', 'opt out'] },
    ],
  },
  {
    label: 'Tools',
    sections: [
      { href: automationsPath(), label: 'Automations', keywords: ['workflows', 'rules', 'triggers'] },
      { href: failedJobsPath(), label: 'Failed Jobs', keywords: ['queue', 'errors', 'dead letters'] },
    ],
  },
]
