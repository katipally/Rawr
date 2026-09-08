/** HubSpot's permission hubs, in the order its own grid reads them left to right.
 *
 *  Listed here as well as in the data access layer because a client bundle cannot
 *  import the database package. `hubs.test.ts` asserts the two lists agree, so the
 *  copy cannot drift. */
export const HUBS = ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'] as const

export type Hub = (typeof HUBS)[number]

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

/** How much of a hub a seat reaches. Mirrors SCOPES in the data access layer;
 *  hubs.test.ts asserts the two agree. */
export const SCOPES = ['everything', 'team', 'own'] as const
export type Scope = (typeof SCOPES)[number]

export const SCOPE_LABEL: Record<Scope, string> = {
  everything: 'All',
  team: "Team's",
  own: 'Mine',
}
