import { sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import type { Hub } from './context.ts'

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
  joinedAt: Date
  /** Sessions issued before this are dead. Null means nobody has signed out everywhere. */
  sessionsValidAfter: Date | null
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
  joined_at: Date | string
  sessions_valid_after: Date | string | null
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
  joinedAt: new Date(r.joined_at),
  sessionsValidAfter: r.sessions_valid_after ? new Date(r.sessions_valid_after) : null,
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
}

/** Links or creates the person, then settles what account they land in: an empty
 *  database is opened by whoever signs in first, a domain some account claims joins
 *  it on that account's terms, a domain no account claims opens one, and anybody
 *  else takes a read-only seat in the visitor account. Returns the user id; the
 *  memberships are read separately so sign-in and every later request go through
 *  the same function. */
export const signInWithGoogle = async (identity: GoogleSignIn): Promise<string> => {
  const [row] = await appDb.execute<{ id: string }>(
    sql`select rawr.sign_in_google(${identity.sub}, ${identity.email}, ${identity.name}, ${identity.picture}, ${identity.hostedDomain}, ${identity.visitorAccount}) as id`,
  )
  if (!row) throw new Error('Sign-in did not return an account.')
  return row.id
}

/** Every session this person holds, on every device, stops working on its next
 *  request. The current one included: the caller signs back in. */
export const signOutEverywhere = async (userId: string): Promise<void> => {
  await appDb.execute(sql`select rawr.sign_out_everywhere(${userId})`)
}
