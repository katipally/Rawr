export const HUBS = ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'] as const
export type Hub = (typeof HUBS)[number]

export type ActorKind = 'user' | 'mcp' | 'job' | 'integration' | 'public'

/** How much of a granted hub a seat reaches. HubSpot's third axis, under view and
 *  edit: everything in the account, everything its team owns, or only its own.
 *
 *  A record's team is its owner's, so moving somebody between teams moves what
 *  they can reach without touching a single record. */
export const SCOPES = ['everything', 'team', 'own'] as const
export type Scope = (typeof SCOPES)[number]

/** A hub left out reaches everything. Stored on the membership and read by the
 *  row level security policy rather than by any query, which is why it is not on
 *  AccountContext: one enforcement point, and no way for a caller to forget it. */
export type HubScopes = Partial<Record<Hub, Scope>>

/** Everything the data access layer needs to answer "who is asking, on behalf of
 *  which account". A request without one of these never reaches the database.
 *
 *  Permissions are the hubs the caller holds, as HubSpot grants them, rather than
 *  one role off a fixed list. `editHubs` does not repeat itself into `viewHubs`;
 *  `canView` unions the two so a grant is only ever written once. */
export type AccountContext = {
  accountId: string
  actorId: string | null
  actorKind: ActorKind
  isSuperAdmin: boolean
  viewHubs: readonly Hub[]
  editHubs: readonly Hub[]
}

/** A hub the seat does not hold, or one set to reach everything, is dropped
 *  rather than stored: the map only ever says where a seat is narrowed, so an
 *  ungranted hub cannot leave a stale scope behind when it is granted again. */
export const assertScopes = (raw: Record<string, string> | undefined, granted: readonly Hub[]): HubScopes => {
  const scopes: HubScopes = {}
  for (const [hub, scope] of Object.entries(raw ?? {})) {
    if (!(HUBS as readonly string[]).includes(hub)) throw new Error(`"${hub}" is not a hub.`)
    if (!(SCOPES as readonly string[]).includes(scope)) throw new Error(`"${scope}" is not a scope.`)
    if (scope === 'everything' || !granted.includes(hub as Hub)) continue
    scopes[hub as Hub] = scope as Scope
  }
  return scopes
}

export class ForbiddenError extends Error {
  // Plain fields rather than constructor parameter properties: Node's type
  // stripping runs the scripts in this package with no transform step.
  readonly hub: Hub | null
  readonly action: string

  constructor(hub: Hub | null, action: string) {
    super(hub ? `You need ${hub} access to ${action}.` : `You cannot ${action}.`)
    this.name = 'ForbiddenError'
    this.hub = hub
    this.action = action
  }
}

export const canView = (ctx: AccountContext, hub: Hub): boolean =>
  ctx.isSuperAdmin || ctx.viewHubs.includes(hub) || ctx.editHubs.includes(hub)

export const canEdit = (ctx: AccountContext, hub: Hub): boolean =>
  ctx.isSuperAdmin || ctx.editHubs.includes(hub)

/** May act on rows that are somebody else's: another person's booking page, their
 *  mailbox, their agent token, their dashboard. Holding the account hub is what
 *  says so, and a super admin holds everything. */
export const isAdmin = (ctx: AccountContext): boolean => canEdit(ctx, 'account')

/** Object level, D5. Enforced here rather than by hiding buttons, so calling a
 *  mutation directly is refused the same way. */
const WRITE_HUB: Record<string, Hub> = {
  company: 'contacts',
  contact: 'contacts',
  deal: 'sales',
  activity: 'contacts',
  task: 'contacts',
  association: 'contacts',
  attachment: 'contacts',
  saved_view: 'contacts',
  import_run: 'contacts',
  pipeline: 'account',
  pipeline_stage: 'account',
  lifecycle_stage: 'account',
  subscription_type: 'marketing',
  subscription_state: 'marketing',
  segment: 'marketing',
  report_dashboard: 'reports',
  object_def: 'account',
  field_def: 'account',
  integration: 'account',
  /** A rule that writes to every record matching a filter is not a thing to hand
   *  to whoever can write one record. */
  automation: 'account',
  /** F6. A dead letter is replayed by whoever can see it. */
  dead_letter: 'account',
  /** An endpoint is a standing copy of everything that happens in this account,
   *  sent somewhere Rawr does not control. That is an account decision however
   *  ordinary the row looks, and the same one as connecting an integration. */
  webhook_endpoint: 'account',
  form: 'marketing',
  form_submission: 'marketing',
  consent_record: 'marketing',
  /** F2. A booking is created by a stranger on the public edge, which acts with
   *  marketing's ceiling. */
  booking: 'sales',
  /** Whether a given page is theirs to change is finer than an object-level grant
   *  can say, so a round robin page and somebody else's personal link are refused
   *  inside the layer. F2 §6. */
  booking_page: 'sales',
  booking_host: 'account',
  availability: 'sales',
  availability_override: 'sales',
  calendar_grant: 'sales',
  /** Seating somebody and ending their access are super admin acts, refused by
   *  `assertSuperAdmin` inside the layer; this entry is the floor under it. */
  membership: 'account',
  /** A team decides where a round-robin lead lands. */
  team: 'account',
  team_member: 'account',
  invitation: 'account',
  sequence: 'sales',
  sequence_step: 'sales',
  sequence_enrollment: 'sales',
  /** A template is words to reuse, not a rule that acts on anybody. */
  email_template: 'sales',
  /** F4. A site key is what lets a host write into this account, so creating one
   *  is an account act however harmless the row looks. */
  site: 'account',
  /** Erasing a person's browsing history is irreversible and is answered to a
   *  regulator, not to a sales target. Deliberately narrower than the grant that
   *  can delete a contact. */
  erasure: 'account',
}

/** A write that is really a reader's own bookkeeping: arranging the numbers you
 *  are allowed to look at. Holding the hub at view level is enough. */
const VIEW_IS_ENOUGH = new Set(['report_dashboard'])

/** Things that are the member's own rather than a hub's, so holding a hub is the
 *  wrong question to ask about them. Every one is guarded by an ownership check
 *  inside the layer, which is finer than an object-level grant can be:
 *
 *  - a token can only ever reach what its holder can reach, and revoking
 *    somebody else's is refused there (F5 §1);
 *  - a mailbox is connected, shared and disconnected by the person whose mailbox
 *    it is (F1 phase B), and an account-wide blocklist entry is refused there (B3);
 *  - how far somebody has read a thread is nobody else's business. */
const ANY_MEMBER = new Set([
  'mcp_token',
  'mcp_oauth_code',
  'mailbox',
  'message_blocklist',
  'message_thread_read',
])

export const canWrite = (ctx: AccountContext, entity: string): boolean => {
  if (ANY_MEMBER.has(entity)) return true
  const hub = WRITE_HUB[entity] ?? 'account'
  return VIEW_IS_ENOUGH.has(entity) ? canView(ctx, hub) : canEdit(ctx, hub)
}

export const assertCanWrite = (ctx: AccountContext, entity: string): void => {
  if (!canWrite(ctx, entity)) {
    throw new ForbiddenError(WRITE_HUB[entity] ?? 'account', `change ${entity} records`)
  }
}

/** Seating somebody, ending their access, and anything else that changes who can
 *  reach this account. Above the hubs, never granted by one. */
export const assertSuperAdmin = (ctx: AccountContext, action: string): void => {
  if (!ctx.isSuperAdmin) throw new ForbiddenError(null, action)
}
