import { CRITICAL_ACTIONS, HUBS, SCOPES, type CriticalAction, type Hub, type Scope } from '@rawr/db/enums'

export { CRITICAL_ACTIONS, HUBS, SCOPES }
export type { CriticalAction, Hub, Scope }

export const HUB_HINT: Record<Hub, string> = {
  contacts: 'Contacts, companies, activity, tasks, imports',
  sales: 'Deals, sequences, mail, meetings',
  marketing: 'Forms, segments, subscriptions, the newsletter',
  service: 'Tickets and the help desk',
  reports: 'Dashboards and the reports behind them',
  account: 'Settings, properties, pipelines, integrations',
}

/** Hubs granted for parity with HubSpot's grid that no screen reads yet. Granting
 *  one changes nothing, so the grid says so rather than implying an effect. */
export const HUBS_WITHOUT_SCREENS = new Set<Hub>(['service'])

/** Hubs whose records carry an owner, and so the only ones a scope can narrow.
 *  Marketing, service, reports and account reach settings and aggregates, which
 *  belong to the account rather than to a person. */
export const HUBS_WITH_RECORDS = new Set<Hub>(['contacts', 'sales'])

export const SCOPE_LABEL: Record<Scope, string> = {
  everything: 'All records',
  team: "Team's records",
  own: 'My records',
}

export const CRITICAL_LABEL: Record<CriticalAction, string> = {
  delete: 'Delete',
  merge: 'Merge',
  bulk_delete: 'Bulk delete',
  import: 'Import',
  export: 'Export',
  purge: 'Permanently delete',
}

export const CRITICAL_HINT: Record<CriticalAction, string> = {
  delete: 'Send one record to the bin. Somebody can still get it back.',
  merge: 'Fold two records into one. Nothing undoes it.',
  bulk_delete: 'Bin a whole selection at once.',
  import: 'Load a file into the database, creating properties it needs.',
  export: 'Download a view as a file that leaves the account.',
  purge: 'Erase data for good, including a deleted property and everything in it.',
}
