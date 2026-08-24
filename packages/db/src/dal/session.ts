import { sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import type { Role } from './context.ts'

export type Membership = {
  workspaceId: string
  workspaceSlug: string
  workspaceName: string
  hostedDomain: string
  userId: string
  email: string
  displayName: string
  avatarUrl: string | null
  role: Role
}

/** The one question row level security cannot answer: which workspaces does this
 *  person belong to, asked before any workspace is chosen. It runs through a
 *  security-definer function that takes a Google subject and nothing else, so it
 *  cannot be turned into a cross-tenant read of anything but memberships. */
export const membershipsForGoogleSub = async (googleSub: string): Promise<Membership[]> => {
  const rows = await appDb.execute<{
    workspace_id: string
    workspace_slug: string
    workspace_name: string
    hosted_domain: string
    user_id: string
    email: string
    display_name: string
    avatar_url: string | null
    role: Role
  }>(sql`select * from rawr.memberships_for_google_sub(${googleSub})`)

  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    workspaceSlug: r.workspace_slug,
    workspaceName: r.workspace_name,
    hostedDomain: r.hosted_domain,
    userId: r.user_id,
    email: r.email,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    role: r.role,
  }))
}
