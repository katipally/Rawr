import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, workspaceId } from './columns.ts'
import { actorKindEnum, memberStateEnum, orgRoleEnum, roleEnum } from './enums.ts'

/** The company. It owns workspaces the way HubSpot's account owns its objects:
 *  one billing relationship, one set of people, several places to keep records.
 *  The Google hosted domain lives here rather than on a workspace, because a
 *  domain identifies a company, not one of its workspaces.
 *
 *  Carries no workspace_id, so the tenancy migration skips it and 0021 writes its
 *  policy by hand against the organisation pinned on the transaction. */
export const organisation = pgTable('organisation', {
  id: pk(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  googleHostedDomain: text('google_hosted_domain').notNull().unique(),
  /** When true, a verified account on that domain joins every workspace here as a
   *  viewer on first sign-in. Off makes the organisation invitation-only. */
  autoJoinHostedDomain: boolean('auto_join_hosted_domain').notNull().default(true),
  /** Null means no cap. Counted against active organisation memberships. */
  seatLimit: integer('seat_limit'),
  createdAt: createdAt(),
})

/** Not a tenant table: it is the tenant. Has no workspace_id, so the tenancy
 *  migration skips it, and it is readable only through a membership join or from
 *  inside its own organisation. */
export const workspace = pgTable('workspace', {
  id: pk(),
  organisationId: uuid('organisation_id')
    .notNull()
    .references(() => organisation.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** Where sequence pixels and click redirects are served from. A dedicated host
   *  keeps sequence mail from carrying links on the app's own domain, which is
   *  what gets an app domain classified as bulk mail. */
  trackingDomain: text('tracking_domain'),
  createdAt: createdAt(),
})

/** Also not a tenant table. One human, one row, regardless of how many
 *  workspaces they belong to. */
export const userAccount = pgTable('user_account', {
  id: pk(),
  email: text('email').notNull().unique(),
  googleSub: text('google_sub').unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  /** Sessions issued before this instant are refused. Set by "sign out everywhere". */
  sessionsValidAfter: timestamp('sessions_valid_after', { withTimezone: true }),
  createdAt: createdAt(),
})

export const membership = pgTable(
  'membership',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('membership_workspace_user_key').on(t.workspaceId, t.userId)],
)

/** Who is in the company, before any question of which workspace. Deactivating
 *  here is what ends somebody's access everywhere at once: `memberships_for_user`
 *  returns nothing for a deactivated person, so their next request has no session. */
export const organisationMembership = pgTable(
  'organisation_membership',
  {
    id: pk(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisation.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    role: orgRoleEnum('role').notNull().default('member'),
    state: memberStateEnum('state').notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => userAccount.id, { onDelete: 'set null' }),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    deactivatedBy: uuid('deactivated_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('organisation_membership_org_user_key').on(t.organisationId, t.userId)],
)

/** A seat offered to an address, with the role it will carry. The token is stored
 *  hashed for the same reason a password would be: the link in the mail is the
 *  credential, and a leaked table must not be a set of working invitations. */
export const invitation = pgTable(
  'invitation',
  {
    id: pk(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisation.id, { onDelete: 'cascade' }),
    /** Null invites into the organisation only, with no workspace seat yet. */
    workspaceId: uuid('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    workspaceRole: roleEnum('workspace_role'),
    orgRole: orgRoleEnum('org_role').notNull().default('member'),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => userAccount.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('invitation_org_idx').on(t.organisationId, t.createdAt.desc())],
)

/** A team inside one workspace. Round robin assignment rotates within a team, so
 *  a form can hand European leads to the people who work them. */
export const team = pgTable(
  'team',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('team_workspace_name_key').on(t.workspaceId, t.name)],
)

export const teamMember = pgTable(
  'team_member',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    teamId: uuid('team_id')
      .notNull()
      .references(() => team.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    isLead: boolean('is_lead').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('team_member_team_user_key').on(t.teamId, t.userId)],
)

/** Append only. The migration revokes UPDATE and DELETE from the app role, so a
 *  bug cannot rewrite history even with a valid session. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    actorKind: actorKindEnum('actor_kind').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.workspaceId, t.entity, t.entityId, t.at.desc()),
    index('audit_log_actor_idx').on(t.workspaceId, t.actorId, t.at.desc()),
  ],
)

/** The same record as `audit_log`, for acts that belong to no single workspace:
 *  seating somebody, creating a workspace, ending access. Append only, by the same
 *  revoke. */
export const organisationAuditLog = pgTable(
  'organisation_audit_log',
  {
    id: pk(),
    organisationId: uuid('organisation_id')
      .notNull()
      .references(() => organisation.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    actorKind: actorKindEnum('actor_kind').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    action: text('action').notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('organisation_audit_entity_idx').on(t.organisationId, t.entity, t.at.desc())],
)
