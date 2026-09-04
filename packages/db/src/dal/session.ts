import { sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import type { Role } from './context.ts'

export type Membership = {
  workspaceId: string
  workspaceSlug: string
  workspaceName: string
  organisationId: string
  organisationSlug: string
  organisationName: string
  orgRole: 'org_admin' | 'member'
  hostedDomain: string
  userId: string
  email: string
  displayName: string
  avatarUrl: string | null
  role: Role
  joinedAt: Date
  /** Sessions issued before this are dead. Null means nobody has signed out everywhere. */
  sessionsValidAfter: Date | null
}

type MembershipRow = {
  workspace_id: string
  workspace_slug: string
  workspace_name: string
  organisation_id: string
  organisation_slug: string
  organisation_name: string
  org_role: 'org_admin' | 'member'
  hosted_domain: string
  user_id: string
  email: string
  display_name: string
  avatar_url: string | null
  role: Role
  joined_at: Date | string
  sessions_valid_after: Date | string | null
}

const toMembership = (r: MembershipRow): Membership => ({
  workspaceId: r.workspace_id,
  workspaceSlug: r.workspace_slug,
  workspaceName: r.workspace_name,
  organisationId: r.organisation_id,
  organisationSlug: r.organisation_slug,
  organisationName: r.organisation_name,
  orgRole: r.org_role,
  hostedDomain: r.hosted_domain,
  userId: r.user_id,
  email: r.email,
  displayName: r.display_name,
  avatarUrl: r.avatar_url,
  role: r.role,
  joinedAt: new Date(r.joined_at),
  sessionsValidAfter: r.sessions_valid_after ? new Date(r.sessions_valid_after) : null,
})

/** The one question row level security cannot answer: which workspaces does this
 *  person belong to, asked before any workspace is chosen. It runs through a
 *  security-definer function that takes a user id and nothing else, so it cannot
 *  be turned into a cross-tenant read of anything but memberships. */
export const membershipsForUser = async (userId: string): Promise<Membership[]> => {
  const rows = await appDb.execute<MembershipRow>(sql`select * from rawr.memberships_for_user(${userId})`)
  return rows.map(toMembership)
}

/** Development sign-in. The caller is responsible for refusing this in production. */
export const userIdForEmail = async (email: string): Promise<string | null> => {
  const [row] = await appDb.execute<{ id: string | null }>(
    sql`select rawr.user_id_for_email(${email}) as id`,
  )
  return row?.id ?? null
}

export type GoogleSignIn = {
  sub: string
  email: string
  name: string
  picture: string | null
  hostedDomain: string
}

/** Links or creates the account, puts it in the organisation that owns its hosted
 *  domain, and seats it as a viewer in that organisation's workspaces when the
 *  organisation allows domain joins. Returns the user id; the memberships are read
 *  separately so sign-in and every later request go through the same function. */
export const signInWithGoogle = async (identity: GoogleSignIn): Promise<string> => {
  const [row] = await appDb.execute<{ id: string }>(
    sql`select rawr.sign_in_google(${identity.sub}, ${identity.email}, ${identity.name}, ${identity.picture}, ${identity.hostedDomain}) as id`,
  )
  if (!row) throw new Error('Sign-in did not return an account.')
  return row.id
}

/** Every session this person holds, on every device, stops working on its next
 *  request. The current one included: the caller signs back in. */
export const signOutEverywhere = async (userId: string): Promise<void> => {
  await appDb.execute(sql`select rawr.sign_out_everywhere(${userId})`)
}
