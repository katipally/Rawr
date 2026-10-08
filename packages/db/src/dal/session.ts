import { sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import type { CriticalAction, Hub } from './context.ts'

export type Membership = {
  accountId: string
  accountSlug: string
  accountName: string
  hostedDomain: string
  userId: string
  email: string
  displayName: string
  avatarUrl: string | null
  isSuperAdmin: boolean
  viewHubs: Hub[]
  editHubs: Hub[]
  criticalGrants: CriticalAction[]
  joinedAt: Date
  /** Sessions issued before this are dead. Null means nobody has signed out everywhere. */
  sessionsValidAfter: Date | null
  accountTimezone: string
  accountCurrency: string
}

type MembershipRow = {
  account_id: string
  account_slug: string
  account_name: string
  hosted_domain: string
  user_id: string
  email: string
  display_name: string
  avatar_url: string | null
  is_super_admin: boolean
  view_hubs: Hub[]
  edit_hubs: Hub[]
  critical_grants: CriticalAction[]
  joined_at: Date | string
  sessions_valid_after: Date | string | null
  account_timezone: string
  account_currency: string
}

const toMembership = (r: MembershipRow): Membership => ({
  accountId: r.account_id,
  accountSlug: r.account_slug,
  accountName: r.account_name,
  hostedDomain: r.hosted_domain,
  userId: r.user_id,
  email: r.email,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  isSuperAdmin: r.is_super_admin,
  viewHubs: r.view_hubs ?? [],
  editHubs: r.edit_hubs ?? [],
  criticalGrants: r.critical_grants ?? [],
  joinedAt: new Date(r.joined_at),
  sessionsValidAfter: r.sessions_valid_after ? new Date(r.sessions_valid_after) : null,
  accountTimezone: r.account_timezone,
  accountCurrency: r.account_currency,
})

/** The one question row level security cannot answer: which accounts does this
 *  person belong to, asked before any account is chosen. It runs through a
 *  security-definer function that takes a user id and nothing else, so it cannot
 *  be turned into a cross-tenant read of anything but memberships. */
export const membershipsForUser = async (userId: string): Promise<Membership[]> => {
  const rows = await appDb.execute<MembershipRow>(sql`select * from rawr.memberships_for_user(${userId})`)
  return rows.map(toMembership)
}

export type GoogleSignIn = {
  sub: string
  email: string
  name: string
  picture: string | null
  /** Null for a consumer address. It claims no domain, so that person is seated as
   *  a visitor rather than by opening or joining an account. */
  hostedDomain: string | null
  /** The account slug an otherwise unseated person joins to read, from
   *  RAWR_VISITOR_ACCOUNT. Empty seats them nowhere, which is what a deployment
   *  that never named one should do. */
  visitorAccount: string
  /** From RAWR_ALLOW_NEW_ACCOUNTS. False means a sign-in never opens an account:
   *  neither the first one on an empty database nor one for a domain nobody
   *  claims. Somebody who already has a seat, or holds an invitation, is
   *  unaffected. */
  mayOpenAccount: boolean
}

/** Links or creates the person, then settles what account they land in: where
 *  `mayOpenAccount` is set, an empty database is opened by whoever signs in first
 *  and a domain no account claims opens one. A domain some account claims joins it
 *  on that account's terms, and anybody else takes a read-only seat in the visitor
 *  account. Returns the user id; the
 *  memberships are read separately so sign-in and every later request go through
 *  the same function. */
export const signInWithGoogle = async (identity: GoogleSignIn): Promise<string> => {
  const [row] = await appDb.execute<{ id: string }>(
    sql`select rawr.sign_in_google(${identity.sub}, ${identity.email}, ${identity.name}, ${identity.picture}, ${identity.hostedDomain}, ${identity.visitorAccount}, ${identity.mayOpenAccount}) as id`,
  )
  if (!row) throw new Error('Sign-in did not return an account.')
  return row.id
}

/** Every session this person holds, on every device, stops working on its next
 *  request. The current one included: the caller signs back in. */
export const signOutEverywhere = async (userId: string): Promise<void> => {
  await appDb.execute(sql`select rawr.sign_out_everywhere(${userId})`)
}

/** A used session writes its last use at most this often. A write on every page view
 *  would make the session table the busiest in the database. */
export const SESSION_TOUCH_MINUTES = 5

export type SignedInSession = {
  id: string
  device: string
  createdAt: Date
  lastSeenAt: Date
}

/** Records a sign-in and returns its id, which the cookie carries. */
export const openSession = async (userId: string, device: string, expiresAt: Date): Promise<string> => {
  const [row] = await appDb.execute<{ id: string }>(
    sql`select rawr.open_user_session(${userId}, ${device}, ${expiresAt.toISOString()}) as id`,
  )
  if (!row) throw new Error('Sign-in did not open a session.')
  return row.id
}

/** False when the session has been ended, has expired, or is not this person's. The
 *  cookie is refused on that request, so an ended session stops on its next use. */
export const touchSession = async (userId: string, sessionId: string): Promise<boolean> => {
  const [row] = await appDb.execute<{ live: boolean }>(
    sql`select rawr.touch_user_session(${userId}, ${sessionId}, make_interval(mins => ${SESSION_TOUCH_MINUTES})) as live`,
  )
  return row?.live === true
}

export const listSessions = async (userId: string): Promise<SignedInSession[]> => {
  const rows = await appDb.execute<{ id: string; device: string; created_at: Date | string; last_seen_at: Date | string }>(
    sql`select * from rawr.sessions_for_user(${userId})`,
  )
  return rows.map((r) => ({
    id: r.id,
    device: r.device,
    createdAt: new Date(r.created_at),
    lastSeenAt: new Date(r.last_seen_at),
  }))
}

/** False when that session is not one of this person's live sessions. */
export const revokeSession = async (userId: string, sessionId: string): Promise<boolean> => {
  const [row] = await appDb.execute<{ revoke_user_session: boolean }>(
    sql`select rawr.revoke_user_session(${userId}, ${sessionId})`,
  )
  return row?.revoke_user_session === true
}

/** Ends every live session of the person except `keepId`. Null keeps none. */
export const revokeOtherSessions = async (userId: string, keepId: string | null): Promise<void> => {
  await appDb.execute(sql`select rawr.revoke_other_user_sessions(${userId}, ${keepId})`)
}
