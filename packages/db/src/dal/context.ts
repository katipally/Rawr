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
  form: ['admin', 'marketing'],
  /** Reviewing the spam queue is sales work as much as marketing work: the lead
   *  being held is somebody's prospect. */
  form_submission: ['admin', 'sales', 'marketing'],
  consent_record: ['admin', 'marketing'],
  membership: ['admin'],
}

export const canWrite = (role: Role, entity: string): boolean =>
  (WRITE_ROLES[entity] ?? ['admin']).includes(role)

export const assertCanWrite = (ctx: WorkspaceContext, entity: string): void => {
  if (!canWrite(ctx.role, entity)) throw new ForbiddenError(ctx.role, `change ${entity} records`)
}
