import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, pk, workspaceId } from './columns.ts'
import { userAccount } from './identity.ts'

/** F5 §1. One token is one person's agent access to one workspace.
 *
 *  Only the hash is stored. The plaintext is shown once at creation and is
 *  unrecoverable afterwards, so a database dump is not a set of live credentials
 *  the way a table of tokens would be.
 *
 *  A token carries no role of its own. It names a user, and the role is read from
 *  that person's membership on every call, so a demotion in Settings takes effect
 *  on the next tool call rather than at the next token rotation. */
export const mcpToken = pgTable(
  'mcp_token',
  {
    id: pk(),
    workspaceId: workspaceId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    /** What the person called it: "Trevor's laptop". Shown in the list so revoking
     *  the right one does not need a guess. */
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    /** The first few characters of the plaintext, kept so a person can tell two
     *  tokens apart without either being readable. */
    prefix: text('prefix').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Set on a token issued through OAuth: the client it was issued to, what it
     *  may do, when the access token dies, and the hash of the refresh token that
     *  replaces it. A token created by hand in Settings has none of these. */
    clientId: text('client_id'),
    scope: text('scope'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    refreshHash: text('refresh_hash'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mcp_token_hash_key').on(t.tokenHash),
    uniqueIndex('mcp_token_refresh_key').on(t.refreshHash),
    index('mcp_token_user_idx').on(t.workspaceId, t.userId, t.createdAt.desc()),
  ],
)

/** An OAuth client: registered dynamically (RFC 7591) or resolved from a Client
 *  ID Metadata Document and cached under its URL. Not tenant data, so no
 *  workspace column and no row level security: a client is a public name and a
 *  list of places it may be sent back to. */
export const mcpClient = pgTable('mcp_client', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: text('redirect_uris').array().notNull().default([]),
  source: text('source').notNull().default('dcr'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  createdAt: createdAt(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})

/** One authorization code, alive for a few minutes between the consent screen and
 *  the token endpoint. Redeemed by deleting it, so it cannot be used twice. */
export const mcpOauthCode = pgTable(
  'mcp_oauth_code',
  {
    id: pk(),
    workspaceId: workspaceId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => userAccount.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    codeHash: text('code_hash').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    resource: text('resource'),
    scope: text('scope'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mcp_oauth_code_hash_key').on(t.codeHash)],
)

/** F5 §Edge cases, "the same write is retried after a timeout".
 *
 *  An agent that times out and retries must not create a second note. The result
 *  of a write is kept under the caller's own key and replayed verbatim, so the
 *  retry answers with the record it already created rather than making another.
 *
 *  Scoped to the token as well as the workspace: two people using the same
 *  obvious key ("update-1") are doing different things. */
export const mcpCall = pgTable(
  'mcp_call',
  {
    id: pk(),
    workspaceId: workspaceId(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => mcpToken.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    tool: text('tool').notNull(),
    result: jsonb('result').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mcp_call_key_key').on(t.workspaceId, t.tokenId, t.idempotencyKey),
    index('mcp_call_age_idx').on(t.createdAt),
  ],
)
