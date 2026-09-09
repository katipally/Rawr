/** Which tools a connection lists, and what each group is for.
 *
 *  Rawr exposes a tool for every screen it has, which is the point and also the
 *  problem: most clients stop accepting tools somewhere around 128, and a model
 *  handed 244 names picks worse than one handed sixty. So a connection lists a
 *  working set and turns the rest on by asking for it:
 *
 *    /api/mcp                      the CRM, and nothing else
 *    /api/mcp?toolsets=all         everything
 *    /api/mcp?toolsets=mail,forms  those, plus core
 *    /api/mcp?toolsets=+reporting  the default set, plus that
 *
 *  This is visibility, never authorization. What a token may do is decided by the
 *  person's role and enforced in Postgres, and an unlisted tool still runs: two
 *  clients on one token would otherwise disagree about which tools exist, and the
 *  disagreement would look exactly like a permission error.
 *
 *  Imports nothing. That is load-bearing rather than tidiness: the settings page's
 *  client component reads these labels, and one import of the catalogue would drag
 *  the whole tRPC router and the database driver into the browser bundle. */

export type Toolset = { label: string; description: string; default?: true }

/** Keyed by the tRPC router segment, which is what `generatedTool` already has in
 *  hand, plus `core` for the ten hand-written tools. */
export const TOOLSETS: Record<string, Toolset> = {
  core: {
    label: 'Everyday CRM',
    description:
      'The ten tools that speak the way a person does: find a record by name, read it, change it, add a note or a task, log a call.',
    default: true,
  },
  crm: {
    label: 'Records and views',
    description:
      'Records of every object including ones an admin invented, views, board, calendar, timeline, tasks, associations, files, imports and exports.',
    default: true,
  },
  admin: {
    label: 'Account settings',
    description:
      'Account settings: objects an admin invents, fields, pipelines, stages, lifecycle, subscription types, members, teams, and automation rules with their run log.',
  },
  integrations: {
    label: 'Integrations and webhooks',
    description:
      'Brevo, Apollo, Clay, Lusha, Woodpecker, Slack, GA4 and Zoom, and reading a HubSpot export: connection, health, enrichment and replay. Also outbound webhooks: the endpoints Rawr posts to, what they subscribe to and their signing secrets.',
  },
  booking: {
    label: 'Booking',
    description: 'Meeting pages, availability, calendars and booked meetings.',
  },
  mail: {
    label: 'Mail',
    description: 'Connected Gmail mailboxes and the email threads on a contact.',
  },
  sequences: {
    label: 'Sequences',
    description:
      "Multi-step outreach sent from a member's own Gmail, or handed to a Woodpecker campaign: the sequences, their steps, and who is in them.",
  },
  reporting: {
    label: 'Reporting',
    description:
      'Six reports over a date range: the pipeline, forms, sequences, email, the website, and which channels the contacts who buy first arrived through.',
  },
  forms: {
    label: 'Forms',
    description: 'Lead forms, their submissions and the review queue.',
  },
  segments: {
    label: 'Segments',
    description: 'Saved audiences built from filters, and who is in them.',
  },
  analytics: {
    label: 'Website analytics',
    description: 'Website page views, events and tracked sites.',
  },
  notifications: {
    label: 'Notifications',
    description:
      'What is waiting on the signed-in person: overdue tasks, held submissions, and, for an admin, what is broken.',
  },
  mcp: {
    label: 'Agent tokens',
    description: 'Agent access tokens.',
  },
  account: {
    label: 'Account and sessions',
    description: "The signed-in person's own account and their sessions.",
  },
  jobs: {
    label: 'Jobs',
    description: 'Failed jobs and dead letters.',
  },
}

/** A router whose tools belong under another name. `session` is one procedure and
 *  does not deserve a group of its own. */
export const TOOLSET_ALIAS: Record<string, string> = { session: 'account' }

export const DEFAULT_TOOLSETS: readonly string[] = Object.entries(TOOLSETS)
  .filter(([, set]) => set.default)
  .map(([key]) => key)

/** What the `toolsets` query parameter means. Never empty and never a refusal: a
 *  typo returns the default set rather than a connection with no tools, which is
 *  a state nothing can recover from without editing client config. */
export const parseToolsets = (raw: string | null | undefined): ReadonlySet<string> => {
  const asked = (raw ?? '').trim()
  if (asked === '') return new Set(DEFAULT_TOOLSETS)
  if (asked === 'all') return new Set(Object.keys(TOOLSETS))

  const additive = asked.startsWith('+')
  const named = (additive ? asked.slice(1) : asked)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part in TOOLSETS)

  if (named.length === 0) return new Set(DEFAULT_TOOLSETS)
  // core always, because without it nothing can turn a name into an id and every
  // other tool takes ids.
  return new Set([...(additive ? DEFAULT_TOOLSETS : []), 'core', ...named])
}
