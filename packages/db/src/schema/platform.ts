import { integer, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, workspaceId } from './columns.ts'
import { integrationStateEnum } from './enums.ts'
import { workspace } from './identity.ts'

/** Credentials are never stored here. secretRef points at the secrets store, which
 *  is deliberately not the database it protects. */
export const integration = pgTable(
  'integration',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    config: jsonb('config').notNull().default({}),
    secretRef: text('secret_ref'),
    state: integrationStateEnum('state').notNull().default('unconfigured'),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('integration_kind_key').on(t.workspaceId, t.kind)],
)

/** A job that fails without landing a row here is a bug, not an incident. */
export const deadLetter = pgTable(
  'dead_letter',
  {
    id: pk(),
    workspaceId: workspaceId().references(() => workspace.id, { onDelete: 'cascade' }),
    integrationId: uuid('integration_id').references(() => integration.id, {
      onDelete: 'set null',
    }),
    jobName: text('job_name').notNull(),
    payload: jsonb('payload').notNull(),
    error: text('error').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dead_letter_open_idx').on(t.workspaceId, t.replayedAt, t.at.desc())],
)
