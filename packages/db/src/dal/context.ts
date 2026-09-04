export const ROLES = ['admin', 'sales', 'marketing', 'viewer'] as const
export type Role = (typeof ROLES)[number]

export type ActorKind = 'user' | 'mcp' | 'job' | 'integration' | 'public'

/** Everything the data access layer needs to answer "who is asking, on behalf of
 *  which workspace". A request without one of these never reaches the database. */
export type WorkspaceContext = {
  workspaceId: string
  actorId: string | null
  actorKind: ActorKind
  role: Role
}

export class ForbiddenError extends Error {
  // Plain fields rather than constructor parameter properties: Node's type
  // stripping runs the scripts in this package with no transform step.
  readonly role: Role
  readonly action: string

  constructor(role: Role, action: string) {
    super(`Your role (${role}) cannot ${action}.`)
    this.name = 'ForbiddenError'
    this.role = role
    this.action = action
  }
}

/** Object-level, four fixed roles, D5. Enforced here rather than by hiding
 *  buttons, so calling a mutation directly is refused the same way. */
const WRITE_ROLES: Record<string, readonly Role[]> = {
  company: ['admin', 'sales', 'marketing'],
  contact: ['admin', 'sales', 'marketing'],
  deal: ['admin', 'sales'],
  activity: ['admin', 'sales', 'marketing'],
  task: ['admin', 'sales', 'marketing'],
  association: ['admin', 'sales', 'marketing'],
  pipeline: ['admin'],
  pipeline_stage: ['admin'],
  lifecycle_stage: ['admin'],
  subscription_type: ['admin', 'marketing'],
  subscription_state: ['admin', 'marketing'],
  segment: ['admin', 'marketing'],
  saved_view: ['admin', 'sales', 'marketing'],
  import_run: ['admin', 'sales', 'marketing'],
  object_def: ['admin'],
  field_def: ['admin'],
  integration: ['admin'],
  /** B11. A rule that writes to every record matching a filter is not a thing to
   *  hand to whoever can write one record. Admins only, both to write the rule
   *  and to read the log of what it did. */
  automation: ['admin'],
  /** F6. A dead letter is replayed by whoever can see it, which is an admin. */
  dead_letter: ['admin'],
  form: ['admin', 'marketing'],
  /** Reviewing the spam queue is sales work as much as marketing work: the lead
   *  being held is somebody's prospect. */
  form_submission: ['admin', 'sales', 'marketing'],
  consent_record: ['admin', 'marketing'],
  /** F2. A booking is created by a stranger on the public edge, which acts with
   *  marketing's ceiling, so the same three roles that can capture a lead can
   *  create one. */
  booking: ['admin', 'sales', 'marketing'],
  /** Anyone but a viewer may own a personal calendar link. Whether a given page is
   *  theirs to change is finer than an object-level role can say, so a round robin
   *  page and somebody else's personal link are refused inside the layer. F2 §6. */
  booking_page: ['admin', 'sales', 'marketing'],
  booking_host: ['admin'],
  availability: ['admin', 'sales', 'marketing'],
  availability_override: ['admin', 'sales', 'marketing'],
  calendar_grant: ['admin', 'sales', 'marketing'],
  membership: ['admin'],
  /** A team is workspace configuration: who is on it decides where a round-robin
   *  lead lands, so changing it is an admin act. */
  team: ['admin'],
  team_member: ['admin'],
  /** Issued from the organisation screen, which checks the organisation role of
   *  its own; this entry only stops a workspace-scoped caller writing one. */
  invitation: ['admin'],
  /** F1 phase B. Anybody but a viewer may connect their own mailbox; whether a
   *  given mailbox is theirs to disconnect is finer than an object-level role can
   *  say, so that is checked inside the layer. */
  mailbox: ['admin', 'sales', 'marketing'],
  /** A personal exclusion is the person's own; a workspace-wide one is an admin
   *  act, refused inside the layer rather than here. B3. */
  message_blocklist: ['admin', 'sales', 'marketing'],
  /** How far somebody has read a thread is their own business, and a viewer reads
   *  threads, so a viewer marks them read. */
  message_thread_read: ['admin', 'sales', 'marketing', 'viewer'],
  /** Outreach is sales and marketing work. Pausing or removing somebody else's
   *  enrollment is finer than a role can say and is checked inside the layer. */
  sequence: ['admin', 'sales', 'marketing'],
  sequence_step: ['admin', 'sales', 'marketing'],
  sequence_enrollment: ['admin', 'sales', 'marketing'],
  /** F5 §1. Anybody may hold agent access to what they can already reach. A token
   *  carries no role of its own, so a viewer's token reads and cannot write, and
   *  revoking somebody else's is refused inside the layer rather than here. */
  mcp_token: ['admin', 'sales', 'marketing', 'viewer'],
  /** An approval on the OAuth consent screen, by the same people who may hold a
   *  token, because it is the same access issued a different way. */
  mcp_oauth_code: ['admin', 'sales', 'marketing', 'viewer'],
  /** F4. A site key is what lets a host write into this workspace, so creating one
   *  is an admin act however harmless the row looks. */
  site: ['admin'],
  /** Erasing a person's browsing history is irreversible and is answered to a
   *  regulator, not to a sales target. Admin only, deliberately narrower than the
   *  three roles that can delete a contact. */
  erasure: ['admin'],
}

export const canWrite = (role: Role, entity: string): boolean =>
  (WRITE_ROLES[entity] ?? ['admin']).includes(role)

export const assertCanWrite = (ctx: WorkspaceContext, entity: string): void => {
  if (!canWrite(ctx.role, entity)) throw new ForbiddenError(ctx.role, `change ${entity} records`)
}
