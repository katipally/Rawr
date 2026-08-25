import { sql } from 'drizzle-orm'
import { hashToken, randomToken } from '../internal/crypto.ts'
import { appDb } from '../internal/pool.ts'
import type { Role, WorkspaceContext } from './context.ts'
import { ForbiddenError } from './context.ts'
import { mutate, withWorkspace } from './index.ts'

/** F5 §1. Tokens, and the lookup that turns one into a workspace context.
 *
 *  Everything an agent can do goes through the same data access layer and the same
 *  role checks as the screens. This file adds the credential and nothing else:
 *  there is no privileged MCP path, which is the property the whole feature rests
 *  on. */

/** Recognisable in a shell history or a config file, so a leaked one is obvious
 *  for what it is and can be revoked rather than puzzled over. */
const PREFIX = 'rawr_mcp_'
const PREVIEW_CHARS = 6

export type McpTokenRow = {
  id: string
  name: string
  prefix: string
  userId: string
  userName: string
  userEmail: string
  lastUsedAt: Date | null
  createdAt: Date
  revokedAt: Date | null
}

type TokenRow = {
  id: string
  name: string
  prefix: string
  user_id: string
  user_name: string
  user_email: string
  last_used_at: Date | string | null
  created_at: Date | string
  revoked_at: Date | string | null
}

const toRow = (row: TokenRow): McpTokenRow => ({
  id: row.id,
  name: row.name,
  prefix: row.prefix,
  userId: row.user_id,
  userName: row.user_name,
  userEmail: row.user_email,
  lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : null,
  createdAt: new Date(row.created_at),
  revokedAt: row.revoked_at ? new Date(row.revoked_at) : null,
})

/** Everyone sees their own tokens. An admin also sees everybody's, because
 *  revoking the token of somebody who has left is workspace security and cannot
 *  wait for them to log in and do it themselves. */
export const listMcpTokens = async (ctx: WorkspaceContext): Promise<McpTokenRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const mine = ctx.role === 'admin' ? sql`true` : sql`t.user_id = ${ctx.actorId}`
    const rows = await tx.execute<TokenRow>(sql`
      select t.id, t.name, t.prefix, t.user_id, u.name as user_name, u.email as user_email,
             t.last_used_at, t.created_at, t.revoked_at
        from mcp_token t
        join user_account u on u.id = t.user_id
       where ${mine}
       order by t.revoked_at nulls first, t.created_at desc`)
    return rows.map(toRow)
  })

export type IssuedToken = { row: McpTokenRow; token: string }

/** The plaintext is returned exactly once, here. Nothing stores it, so a person who
 *  loses it makes a new one rather than recovering the old. */
export const createMcpToken = async (
  ctx: WorkspaceContext,
  input: { name: string },
): Promise<IssuedToken> => {
  const name = input.name.trim()
  if (!name) throw new Error('Give the token a name, so the right one can be revoked later.')
  if (name.length > 80) throw new Error('That name is too long. Eighty characters is the limit.')
  if (!ctx.actorId) throw new Error('A token belongs to a person, and this request has no one.')
  // A viewer reads through MCP exactly as they read the screens, so they may hold a
  // token. What it cannot do is written in the layer, not in who may hold one.
  const token = `${PREFIX}${randomToken(32)}`

  return mutate<IssuedToken>(ctx, 'mcp_token', async (tx) => {
    const [row] = await tx.execute<TokenRow>(sql`
      with inserted as (
        insert into mcp_token (workspace_id, user_id, name, token_hash, prefix)
        values (${ctx.workspaceId}, ${ctx.actorId}, ${name}, ${hashToken(token)},
                ${token.slice(0, PREFIX.length + PREVIEW_CHARS)})
        returning *
      )
      select i.id, i.name, i.prefix, i.user_id, u.name as user_name, u.email as user_email,
             i.last_used_at, i.created_at, i.revoked_at
        from inserted i join user_account u on u.id = i.user_id`)

    if (!row) throw new Error('The token could not be created.')
    return {
      result: { row: toRow(row), token },
      audit: {
        entity: 'mcp_token',
        entityId: row.id,
        action: 'create',
        before: null,
        // Never the token, and never the hash: an audit log is readable by an
        // admin, and neither belongs in something readable.
        after: { name, prefix: row.prefix },
      },
    }
  })
}

/** Idempotent: revoking twice reports the same thing both times, because somebody
 *  who is not sure it worked will click again. */
export const revokeMcpToken = async (ctx: WorkspaceContext, id: string): Promise<boolean> =>
  mutate<boolean>(ctx, 'mcp_token', async (tx) => {
    const [existing] = await tx.execute<{ user_id: string; name: string; revoked_at: Date | null }>(
      sql`select user_id, name, revoked_at from mcp_token where id = ${id} limit 1`,
    )
    if (!existing) throw new Error('That token no longer exists.')
    if (existing.user_id !== ctx.actorId && ctx.role !== 'admin') {
      throw new ForbiddenError(ctx.role, "revoke somebody else's token")
    }

    const rows = await tx.execute<{ id: string }>(sql`
      update mcp_token set revoked_at = now()
       where id = ${id} and revoked_at is null
       returning id`)

    return {
      result: rows.length > 0,
      audit: {
        entity: 'mcp_token',
        entityId: id,
        action: 'revoke',
        before: { name: existing.name, revoked: existing.revoked_at !== null },
        after: { name: existing.name, revoked: true },
      },
    }
  })

// ---------------------------------------------------------------------------
// The lookup
// ---------------------------------------------------------------------------

export type McpCaller = {
  tokenId: string
  ctx: WorkspaceContext
  workspaceSlug: string
  workspaceName: string
  userId: string
  userEmail: string
  userName: string
  role: Role
}

/** A request carrying a token has no session and does not know its own tenant. The
 *  security-definer function answers with ids and a live role and nothing else, and
 *  answers nothing at all for a revoked token, which is what makes revocation take
 *  effect on the next call rather than at the next cache expiry. */
export const callerForToken = async (plaintext: string): Promise<McpCaller | null> => {
  if (!plaintext.startsWith(PREFIX) || plaintext.length < PREFIX.length + 20) return null

  const rows = await appDb.execute<{
    token_id: string
    workspace_id: string
    workspace_slug: string
    workspace_name: string
    user_id: string
    user_email: string
    user_name: string
    role: Role
  }>(sql`select * from rawr.mcp_token_owner(${hashToken(plaintext)})`)

  const found = rows[0]
  if (!found) return null

  return {
    tokenId: found.token_id,
    ctx: {
      workspaceId: found.workspace_id,
      actorId: found.user_id,
      // The audit log says which person did it, through which door. "The MCP
      // server did it" is not an answer anybody can act on. F5 §1.
      actorKind: 'mcp',
      role: found.role,
    },
    workspaceSlug: found.workspace_slug,
    workspaceName: found.workspace_name,
    userId: found.user_id,
    userEmail: found.user_email,
    userName: found.user_name,
    role: found.role,
  }
}

/** Fire and forget: a failed timestamp is not worth failing a tool call over. */
export const touchMcpToken = (tokenId: string): void => {
  void appDb.execute(sql`select rawr.mcp_token_used(${tokenId})`).catch(() => {})
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/** Kept for a day. Long enough that a client retrying a timed-out call gets the
 *  original answer, short enough that the table does not become a second copy of
 *  everything the agent has ever written. */
const KEEP_HOURS = 24

export const recallMcpCall = async (
  ctx: WorkspaceContext,
  tokenId: string,
  key: string,
): Promise<unknown | null> =>
  withWorkspace(ctx, async (tx) => {
    const [row] = await tx.execute<{ result: unknown }>(sql`
      select result from mcp_call
       where token_id = ${tokenId} and idempotency_key = ${key}
         and created_at > now() - make_interval(hours => ${KEEP_HOURS})
       limit 1`)
    return row?.result ?? null
  })

/** Written after the work, so a call that failed can be retried rather than being
 *  answered forever with its own failure. */
export const rememberMcpCall = async (
  ctx: WorkspaceContext,
  input: { tokenId: string; key: string; tool: string; result: unknown },
): Promise<void> => {
  await withWorkspace(ctx, async (tx) => {
    await tx.execute(sql`
      insert into mcp_call (workspace_id, token_id, idempotency_key, tool, result)
      values (${ctx.workspaceId}, ${input.tokenId}, ${input.key}, ${input.tool},
              ${JSON.stringify(input.result)}::jsonb)
      on conflict (workspace_id, token_id, idempotency_key) do nothing`)
    // Cheap on an indexed column, and it keeps the ledger from needing a job of its
    // own for a table that only ever holds a day of rows.
    await tx.execute(sql`
      delete from mcp_call where created_at < now() - make_interval(hours => ${KEEP_HOURS * 2})`)
  })
}
