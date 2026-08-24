import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, workspaceId } from './columns.ts'
import { actorKindEnum, roleEnum } from './enums.ts'

/** Not a tenant table: it is the tenant. Has no workspace_id, so the tenancy
 *  migration skips it, and it is readable only through a membership join. */
export const workspace = pgTable('workspace', {
  id: pk(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  googleHostedDomain: text('google_hosted_domain').notNull(),
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
