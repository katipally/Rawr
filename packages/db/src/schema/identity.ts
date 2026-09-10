import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { accountId, createdAt, pk } from './columns.ts'
import { actorKindEnum, hubEnum, memberStateEnum } from './enums.ts'
import type { HubScopes } from '../dal/context.ts'

/** The tenant, and the only one. HubSpot calls it an account, addresses it by a
 *  portal id in every URL, and puts nothing above or below it: one billing
 *  relationship, one set of people, one CRM database. Datasaur's own portal runs
 *  this way, with no teams and no business units, which is why the organisation
 *  that used to sit above this table is gone.
 *
 *  Carries no account_id, so the tenancy migration skips it and writes its policy
 *  by hand against the account pinned on the transaction. */
export const account = pgTable('account', {
  id: pk(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  googleHostedDomain: text('google_hosted_domain').notNull().unique(),
  /** When true, a verified account on that domain joins on first sign-in, reading
   *  the hubs `defaultViewHubs` names. Off makes the account invitation-only. */
  autoJoinHostedDomain: boolean('auto_join_hosted_domain').notNull().default(true),
  /** What a domain joiner arrives holding. Empty means they arrive with a seat and
   *  nothing to look at, which is the safe default for a domain nobody vetted. */
  defaultViewHubs: hubEnum('default_view_hubs').array().notNull().default([]),
  /** Null means no cap. Counted against active memberships. */
  seatLimit: integer('seat_limit'),
  /** Months of raw page views. A data-protection decision, so the company owns it. */
  activityRetentionMonths: integer('activity_retention_months').notNull().default(25),
  /** Whether a contact must positively agree before mail to them carries a pixel
   *  or a rewritten link. Off is the US default, where measurement is lawful
   *  without asking; on is what ePrivacy expects, and makes an `unspecified`
   *  contact untracked rather than tracked. A data-protection decision, so the
   *  company owns it, like `activityRetentionMonths`. */
  trackingRequiresConsent: boolean('tracking_requires_consent').notNull().default(false),
  /** Where sequence pixels and click redirects are served from. A dedicated host
   *  keeps sequence mail from carrying links on the app's own domain, which is
   *  what gets an app domain classified as bulk mail. */
  trackingDomain: text('tracking_domain'),
  createdAt: createdAt(),
})

/** Also not a tenant table. One human, one row. */
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

/** Who is in the account and what they hold, as HubSpot grants it: a set of hubs
 *  they may read and a set they may write, rather than one role off a fixed list.
 *  Edit does not imply view in the columns; `canRead` unions the two, so a grant
 *  only has to be written once.
 *
 *  Deactivating here is what ends somebody's access: `membershipsForUser` returns
 *  nothing for a deactivated person, so their next request has no session. */
export const membership = pgTable(
  'membership',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    /** Above the grants, not a hub in them. Carries every permission there is and
     *  is the only thing that may seat somebody or end their access. */
    isSuperAdmin: boolean('is_super_admin').notNull().default(false),
    viewHubs: hubEnum('view_hubs').array().notNull().default([]),
    editHubs: hubEnum('edit_hubs').array().notNull().default([]),
    /** How much of each granted hub this seat reaches: everything in the account,
     *  everything its team owns, or only what it owns. A hub left out of the map
     *  reaches everything, so a seat written before scopes existed is unchanged.
     *  Read by the row level security policy, never by a query, so the exporter
     *  and the agent surface obey it without knowing it is there. */
    viewScopes: jsonb('view_scopes').$type<HubScopes>().notNull().default({}),
    editScopes: jsonb('edit_scopes').$type<HubScopes>().notNull().default({}),
    state: memberStateEnum('state').notNull().default('active'),
    invitedBy: uuid('invited_by').references(() => userAccount.id, { onDelete: 'set null' }),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    deactivatedBy: uuid('deactivated_by').references(() => userAccount.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('membership_account_user_key').on(t.accountId, t.userId)],
)

/** A seat offered to an address, with the grants it will carry. The token is
 *  stored hashed for the same reason a password would be: the link in the mail is
 *  the credential, and a leaked table must not be a set of working invitations. */
export const invitation = pgTable(
  'invitation',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    isSuperAdmin: boolean('is_super_admin').notNull().default(false),
    viewHubs: hubEnum('view_hubs').array().notNull().default([]),
    editHubs: hubEnum('edit_hubs').array().notNull().default([]),
    viewScopes: jsonb('view_scopes').$type<HubScopes>().notNull().default({}),
    editScopes: jsonb('edit_scopes').$type<HubScopes>().notNull().default({}),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => userAccount.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('invitation_account_idx').on(t.accountId, t.createdAt.desc())],
)

/** A team inside the account. Round robin assignment rotates within a team, so a
 *  form can hand European leads to the people who work them. */
export const team = pgTable(
  'team',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('team_account_name_key').on(t.accountId, t.name)],
)

export const teamMember = pgTable(
  'team_member',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
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
 *  bug cannot rewrite history even with a valid session. Seating somebody and
 *  ending their access are recorded here too: with one tenant there is no act that
 *  belongs to no account. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: pk(),
    accountId: accountId().references(() => account.id, { onDelete: 'cascade' }),
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
    index('audit_log_entity_idx').on(t.accountId, t.entity, t.entityId, t.at.desc()),
    index('audit_log_actor_idx').on(t.accountId, t.actorId, t.at.desc()),
  ],
)
