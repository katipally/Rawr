import { sql } from 'drizzle-orm'
import { hashToken, randomToken } from '../internal/crypto.ts'
import { appDb } from '../internal/pool.ts'
import { ForbiddenError, isAdmin, type Hub, type AccountContext } from './context.ts'
import { mutate, withAccount } from './index.ts'

/** F5 §1. Tokens, and the lookup that turns one into an account context.
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
 *  revoking the token of somebody who has left is account security and cannot
 *  wait for them to log in and do it themselves. */
export const listMcpTokens = async (ctx: AccountContext): Promise<McpTokenRow[]> =>
  withAccount(ctx, async (tx) => {
    const mine = isAdmin(ctx) ? sql`true` : sql`t.user_id = ${ctx.actorId}`
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
  ctx: AccountContext,
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
        insert into mcp_token (account_id, user_id, name, token_hash, prefix)
        values (${ctx.accountId}, ${ctx.actorId}, ${name}, ${hashToken(token)},
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
export const revokeMcpToken = async (ctx: AccountContext, id: string): Promise<boolean> =>
  mutate<boolean>(ctx, 'mcp_token', async (tx) => {
    const [existing] = await tx.execute<{ user_id: string; name: string; revoked_at: Date | null }>(
      sql`select user_id, name, revoked_at from mcp_token where id = ${id} limit 1`,
    )
    if (!existing) throw new Error('That token no longer exists.')
    if (existing.user_id !== ctx.actorId && !isAdmin(ctx)) {
      throw new ForbiddenError('account', "revoke somebody else's token")
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
  ctx: AccountContext
  accountSlug: string
  accountName: string
  userId: string
  userEmail: string
  userName: string
}

/** A request carrying a token has no session and does not know its own tenant. The
 *  security-definer function answers with ids and live grants and nothing else, and
 *  answers nothing at all for a revoked token, which is what makes revocation take
 *  effect on the next call rather than at the next cache expiry. */
export const callerForToken = async (plaintext: string): Promise<McpCaller | null> => {
  if (!plaintext.startsWith(PREFIX) || plaintext.length < PREFIX.length + 20) return null

  const rows = await appDb.execute<{
    token_id: string
    account_id: string
    account_slug: string
    account_name: string
    user_id: string
    user_email: string
    user_name: string
    is_super_admin: boolean
    view_hubs: Hub[]
    edit_hubs: Hub[]
  }>(sql`select * from rawr.mcp_token_owner(${hashToken(plaintext)})`)

  const found = rows[0]
  if (!found) return null

  return {
    tokenId: found.token_id,
    ctx: {
      accountId: found.account_id,
      actorId: found.user_id,
      // The audit log says which person did it, through which door. "The MCP
      // server did it" is not an answer anybody can act on. F5 §1.
      actorKind: 'mcp',
      isSuperAdmin: found.is_super_admin,
      viewHubs: found.view_hubs ?? [],
      editHubs: found.edit_hubs ?? [],
    },
    accountSlug: found.account_slug,
    accountName: found.account_name,
    userId: found.user_id,
    userEmail: found.user_email,
    userName: found.user_name,
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
  ctx: AccountContext,
  tokenId: string,
  key: string,
): Promise<unknown | null> =>
  withAccount(ctx, async (tx) => {
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
  ctx: AccountContext,
  input: { tokenId: string; key: string; tool: string; result: unknown },
): Promise<void> => {
  await withAccount(ctx, async (tx) => {
    await tx.execute(sql`
      insert into mcp_call (account_id, token_id, idempotency_key, tool, result)
      values (${ctx.accountId}, ${input.tokenId}, ${input.key}, ${input.tool},
              ${JSON.stringify(input.result)}::jsonb)
      on conflict (account_id, token_id, idempotency_key) do nothing`)
    // Cheap on an indexed column, and it keeps the ledger from needing a job of its
    // own for a table that only ever holds a day of rows.
    await tx.execute(sql`
      delete from mcp_call where created_at < now() - make_interval(hours => ${KEEP_HOURS * 2})`)
  })
}

// ---------------------------------------------------------------------------
// OAuth 2.1: clients, codes, and tokens issued through consent
// ---------------------------------------------------------------------------

/** An access token issued through OAuth lives an hour; the refresh token that
 *  comes with it lives until the token is revoked, and is replaced on every use
 *  (OAuth 2.1 rotation for public clients). */
export const OAUTH_ACCESS_SECONDS = 60 * 60
const REFRESH_PREFIX = 'rawr_mcp_refresh_'

export type McpClientRow = {
  id: string
  name: string
  redirectUris: string[]
  source: 'dcr' | 'cimd'
  fetchedAt: Date | null
}

type ClientRow = {
  id: string
  name: string
  redirect_uris: string[]
  source: string
  fetched_at: Date | string | null
}

const toClient = (row: ClientRow): McpClientRow => ({
  id: row.id,
  name: row.name,
  redirectUris: row.redirect_uris,
  source: row.source === 'cimd' ? 'cimd' : 'dcr',
  fetchedAt: row.fetched_at ? new Date(row.fetched_at) : null,
})

/** Outside any tenant, deliberately: a client registers before anybody has signed
 *  in, and its record is a name and a redirect list, not account data. */
export const saveMcpClient = async (input: {
  id: string
  name: string
  redirectUris: string[]
  source: 'dcr' | 'cimd'
}): Promise<McpClientRow> => {
  const [row] = await appDb.execute<ClientRow>(sql`
    insert into mcp_client (id, name, redirect_uris, source, fetched_at)
    values (${input.id}, ${input.name},
            (select coalesce(array_agg(uri), '{}') from jsonb_array_elements_text(${JSON.stringify(input.redirectUris)}::jsonb) uri),
            ${input.source},
            ${input.source === 'cimd' ? sql`now()` : sql`null`})
    on conflict (id) do update
      set name = excluded.name, redirect_uris = excluded.redirect_uris,
          fetched_at = excluded.fetched_at
    returning id, name, redirect_uris, source, fetched_at`)
  if (!row) throw new Error('The client could not be registered.')
  return toClient(row)
}

export const readMcpClient = async (id: string): Promise<McpClientRow | null> => {
  const [row] = await appDb.execute<ClientRow>(sql`
    select id, name, redirect_uris, source, fetched_at from mcp_client where id = ${id} limit 1`)
  return row ? toClient(row) : null
}

/** Written by the person approving on the consent screen. The plaintext goes back
 *  to the client in the redirect and is never stored. */
export const createOauthCode = async (
  ctx: AccountContext,
  input: { clientId: string; codeChallenge: string; redirectUri: string; resource: string | null; scope: string | null },
): Promise<string> => {
  if (!ctx.actorId) throw new Error('An approval belongs to a person, and this request has no one.')
  const code = randomToken(32)
  await mutate(ctx, 'mcp_oauth_code', async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into mcp_oauth_code
        (account_id, user_id, client_id, code_hash, code_challenge, redirect_uri, resource, scope, expires_at)
      values (${ctx.accountId}, ${ctx.actorId}, ${input.clientId}, ${hashToken(code)},
              ${input.codeChallenge}, ${input.redirectUri}, ${input.resource}, ${input.scope},
              now() + interval '5 minutes')
      returning id`)
    return {
      result: undefined,
      audit: {
        entity: 'mcp_oauth_code',
        entityId: row?.id ?? null,
        action: 'approve',
        before: null,
        after: { clientId: input.clientId, redirectUri: input.redirectUri },
      },
    }
  })
  await appDb.execute(sql`update mcp_client set last_used_at = now() where id = ${input.clientId}`)
  return code
}

export type RedeemedCode = {
  accountId: string
  userId: string
  clientId: string
  codeChallenge: string
  redirectUri: string
  resource: string | null
  scope: string | null
  expiresAt: Date
}

/** Single use: the row is deleted as it is read. An expired code is returned so
 *  the caller can name the reason, and is gone either way. */
export const redeemOauthCode = async (plaintext: string): Promise<RedeemedCode | null> => {
  const [row] = await appDb.execute<{
    account_id: string
    user_id: string
    client_id: string
    code_challenge: string
    redirect_uri: string
    resource: string | null
    scope: string | null
    expires_at: Date | string
  }>(sql`select * from rawr.mcp_code_redeem(${hashToken(plaintext)})`)
  if (!row) return null
  return {
    accountId: row.account_id,
    userId: row.user_id,
    clientId: row.client_id,
    codeChallenge: row.code_challenge,
    redirectUri: row.redirect_uri,
    resource: row.resource,
    scope: row.scope,
    expiresAt: new Date(row.expires_at),
  }
}

export type IssuedOauthToken = { accessToken: string; refreshToken: string; expiresIn: number; scope: string | null }

const oauthContext = (accountId: string, userId: string): AccountContext => ({
  accountId,
  actorId: userId,
  actorKind: 'user',
  // Issuing the token grants nothing of its own: `callerForToken` reads the
  // holder's live grants on every call, so a token can only ever reach what its
  // holder can reach at the time it is used.
  isSuperAdmin: false,
  viewHubs: [],
  editHubs: [],
})

/** A token the consent flow issues. It is an mcp_token like any other, named
 *  after the client, so it appears in Settings and is revoked the same way. */
export const issueOauthToken = async (input: {
  accountId: string
  userId: string
  clientId: string
  clientName: string
  scope: string | null
}): Promise<IssuedOauthToken> => {
  const accessToken = `${PREFIX}${randomToken(32)}`
  const refreshToken = `${REFRESH_PREFIX}${randomToken(32)}`
  const ctx = oauthContext(input.accountId, input.userId)

  await mutate(ctx, 'mcp_token', async (tx) => {
    const [row] = await tx.execute<{ id: string; prefix: string }>(sql`
      insert into mcp_token
        (account_id, user_id, name, token_hash, prefix, client_id, scope, expires_at, refresh_hash)
      values (${ctx.accountId}, ${ctx.actorId}, ${input.clientName}, ${hashToken(accessToken)},
              ${accessToken.slice(0, PREFIX.length + PREVIEW_CHARS)}, ${input.clientId}, ${input.scope},
              now() + make_interval(secs => ${OAUTH_ACCESS_SECONDS}), ${hashToken(refreshToken)})
      returning id, prefix`)
    return {
      result: undefined,
      audit: {
        entity: 'mcp_token',
        entityId: row?.id ?? null,
        action: 'create',
        before: null,
        after: { name: input.clientName, prefix: row?.prefix, clientId: input.clientId, via: 'oauth' },
      },
    }
  })

  return { accessToken, refreshToken, expiresIn: OAUTH_ACCESS_SECONDS, scope: input.scope }
}

/** Rotation: the presented refresh token is replaced in the same update that
 *  mints the new access token, so the old one stops working the moment the new
 *  one exists. Returns null for a refresh token that is unknown, revoked, or
 *  already rotated, and the caller answers `invalid_grant`. */
export const refreshOauthToken = async (
  plaintext: string,
  clientId: string,
): Promise<IssuedOauthToken | null> => {
  if (!plaintext.startsWith(REFRESH_PREFIX)) return null
  const [owner] = await appDb.execute<{
    token_id: string
    account_id: string
    user_id: string
    client_id: string | null
    scope: string | null
  }>(sql`select * from rawr.mcp_refresh_owner(${hashToken(plaintext)})`)
  if (!owner || owner.client_id !== clientId) return null

  const accessToken = `${PREFIX}${randomToken(32)}`
  const refreshToken = `${REFRESH_PREFIX}${randomToken(32)}`
  const ctx = oauthContext(owner.account_id, owner.user_id)

  const rotated = await withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      update mcp_token
         set token_hash = ${hashToken(accessToken)},
             prefix = ${accessToken.slice(0, PREFIX.length + PREVIEW_CHARS)},
             refresh_hash = ${hashToken(refreshToken)},
             expires_at = now() + make_interval(secs => ${OAUTH_ACCESS_SECONDS})
       where id = ${owner.token_id} and refresh_hash = ${hashToken(plaintext)} and revoked_at is null
       returning id`)
    return rows.length > 0
  })
  if (!rotated) return null

  return { accessToken, refreshToken, expiresIn: OAUTH_ACCESS_SECONDS, scope: owner.scope }
}
