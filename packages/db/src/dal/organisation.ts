import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import {
  invitation,
  membership,
  organisation,
  organisationAuditLog,
  organisationMembership,
  userAccount,
  workspace,
} from '../schema/identity.ts'
import { ROLES, type ActorKind, type Role } from './context.ts'
import type { AuditEntry, Tx } from './index.ts'
import { provisionWorkspace } from './provision.ts'

/** The company, one level above a workspace. Everything here is scoped by a second
 *  connection setting, `rawr.organisation_id`, with its own row level security
 *  policies: workspace scoping answers "which tenant", this answers "which
 *  company", and the two never stand in for each other.
 *
 *  Org-level writes are gated on `orgRole` in this file rather than in the
 *  workspace role matrix, because being an admin of one workspace says nothing
 *  about who may end somebody's access across all of them. */

export type OrgRole = 'org_admin' | 'member'
export type MemberState = 'active' | 'invited' | 'deactivated'

export type OrganisationContext = {
  organisationId: string
  actorId: string | null
  actorKind: ActorKind
  orgRole: OrgRole
}

export class OrgForbiddenError extends Error {
  constructor(action: string) {
    super(`Only an organisation admin can ${action}.`)
    this.name = 'OrgForbiddenError'
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Pins the organisation for the transaction, the way `withWorkspace` pins the
 *  workspace. Deliberately not the same helper: a call that sets one scope must
 *  never accidentally satisfy the other's policy. */
export const withOrganisation = async <T>(
  ctx: OrganisationContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> => {
  if (!UUID.test(ctx.organisationId)) {
    throw new Error(`Refusing to open a transaction: "${ctx.organisationId}" is not an organisation id.`)
  }
  return appDb.transaction(async (tx) => {
    await tx.execute(sql`select set_config('rawr.organisation_id', ${sql.raw(`'${ctx.organisationId}'`)}, true)`)
    return fn(tx)
  })
}

const assertOrgAdmin = (ctx: OrganisationContext, action: string): void => {
  if (ctx.orgRole !== 'org_admin') throw new OrgForbiddenError(action)
}

/** Guard, change, record, the way `mutate` does for a workspace. */
const mutateOrg = async <T>(
  ctx: OrganisationContext,
  action: string,
  fn: (tx: Tx) => Promise<{ result: T; audit: AuditEntry }>,
): Promise<T> => {
  assertOrgAdmin(ctx, action)
  return withOrganisation(ctx, async (tx) => {
    const { result, audit } = await fn(tx)
    await tx.insert(organisationAuditLog).values({
      organisationId: ctx.organisationId,
      actorId: ctx.actorId,
      actorKind: ctx.actorKind,
      entity: audit.entity,
      entityId: audit.entityId,
      action: audit.action,
      before: audit.before ?? null,
      after: audit.after ?? null,
    })
    return result
  })
}

export type Organisation = {
  id: string
  name: string
  slug: string
  hostedDomain: string
  autoJoinHostedDomain: boolean
  seatLimit: number | null
  seatsUsed: number
}

export const readOrganisation = async (ctx: OrganisationContext): Promise<Organisation> =>
  withOrganisation(ctx, async (tx) => {
    const [row] = await tx.execute<{
      id: string
      name: string
      slug: string
      google_hosted_domain: string
      auto_join_hosted_domain: boolean
      seat_limit: number | null
      seats_used: number
    }>(sql`
      select o.*,
             (select count(*) from organisation_membership om
               where om.organisation_id = o.id and om.state <> 'deactivated')::int as seats_used
        from organisation o
       limit 1
    `)
    if (!row) throw new Error('That organisation no longer exists.')
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      hostedDomain: row.google_hosted_domain,
      autoJoinHostedDomain: row.auto_join_hosted_domain,
      seatLimit: row.seat_limit === null ? null : Number(row.seat_limit),
      seatsUsed: Number(row.seats_used),
    }
  })

export const saveOrganisation = async (
  ctx: OrganisationContext,
  input: {
    name?: string | undefined
    autoJoinHostedDomain?: boolean | undefined
    seatLimit?: number | null | undefined
  },
): Promise<void> =>
  mutateOrg(ctx, 'change the organisation', async (tx) => {
    const [before] = await tx.select().from(organisation).limit(1)
    if (!before) throw new Error('That organisation no longer exists.')
    const name = input.name?.trim()
    if (name !== undefined && name === '') throw new Error('An organisation needs a name.')
    if (input.seatLimit !== undefined && input.seatLimit !== null && input.seatLimit < 1) {
      throw new Error('A seat limit is at least one.')
    }
    await tx
      .update(organisation)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(input.autoJoinHostedDomain === undefined ? {} : { autoJoinHostedDomain: input.autoJoinHostedDomain }),
        ...(input.seatLimit === undefined ? {} : { seatLimit: input.seatLimit }),
      })
      .where(eq(organisation.id, ctx.organisationId))
    return {
      result: undefined,
      audit: { entity: 'organisation', entityId: ctx.organisationId, action: 'update', before, after: input },
    }
  })

export type OrgWorkspace = {
  id: string
  name: string
  slug: string
  members: number
  createdAt: Date
}

export const listOrgWorkspaces = async (ctx: OrganisationContext): Promise<OrgWorkspace[]> =>
  withOrganisation(ctx, async (tx) => {
    const rows = await tx.execute<{ id: string; name: string; slug: string; members: number; created_at: Date }>(sql`
      select w.id, w.name, w.slug, w.created_at,
             (select count(*) from membership m where m.workspace_id = w.id)::int as members
        from workspace w
       order by w.name
    `)
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      members: Number(row.members),
      createdAt: new Date(row.created_at),
    }))
  })

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

export const createWorkspace = async (
  ctx: OrganisationContext,
  input: { name: string; slug: string },
): Promise<{ id: string }> =>
  mutateOrg(ctx, 'create a workspace', async (tx) => {
    const name = input.name.trim()
    const slug = input.slug.trim().toLowerCase()
    if (name === '') throw new Error('A workspace needs a name.')
    if (!SLUG.test(slug)) {
      throw new Error('A slug is lower-case letters, numbers and hyphens, and it appears in every address.')
    }
    const [created] = await tx
      .insert(workspace)
      .values({ organisationId: ctx.organisationId, name, slug })
      .onConflictDoNothing()
      .returning({ id: workspace.id })
    if (!created) throw new Error(`Another workspace already uses the address "${slug}".`)

    // The same provisioning the seed does, so a workspace created here is not a
    // half-built one missing the views every address falls back to. The insert
    // above is policy-checked against this organisation, so this is in scope.
    await tx.execute(sql`select set_config('rawr.workspace_id', ${sql.raw(`'${created.id}'`)}, true)`)
    await provisionWorkspace(tx, created.id)

    // Whoever created it administers it, or nobody could open it.
    if (ctx.actorId) {
      await tx.insert(membership).values({ workspaceId: created.id, userId: ctx.actorId, role: 'admin' })
    }
    return {
      result: { id: created.id },
      audit: { entity: 'workspace', entityId: created.id, action: 'create', after: { name, slug } },
    }
  })

export const renameWorkspace = async (
  ctx: OrganisationContext,
  input: { workspaceId: string; name: string },
): Promise<void> =>
  mutateOrg(ctx, 'rename a workspace', async (tx) => {
    const name = input.name.trim()
    if (name === '') throw new Error('A workspace needs a name.')
    const [before] = await tx.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, input.workspaceId))
    if (!before) throw new Error('That workspace is not in this organisation.')
    await tx.update(workspace).set({ name }).where(eq(workspace.id, input.workspaceId))
    return {
      result: undefined,
      audit: { entity: 'workspace', entityId: input.workspaceId, action: 'rename', before, after: { name } },
    }
  })

export type OrgMember = {
  userId: string
  email: string
  name: string
  orgRole: OrgRole
  state: MemberState
  linked: boolean
  joinedAt: Date
  deactivatedAt: Date | null
  /** Which workspaces they are seated in, and as what. */
  seats: { workspaceId: string; workspaceName: string; role: Role }[]
}

export const listOrgMembers = async (ctx: OrganisationContext): Promise<OrgMember[]> =>
  withOrganisation(ctx, async (tx) => {
    const rows = await tx.execute<{
      user_id: string
      email: string
      name: string
      google_sub: string | null
      org_role: OrgRole
      state: MemberState
      created_at: Date
      deactivated_at: Date | null
      seats: { workspaceId: string; workspaceName: string; role: Role }[] | null
    }>(sql`
      select u.id as user_id, u.email, u.name, u.google_sub,
             om.role as org_role, om.state, om.created_at, om.deactivated_at,
             (select json_agg(json_build_object('workspaceId', w.id, 'workspaceName', w.name, 'role', m.role)
                              order by w.name)
                from membership m join workspace w on w.id = m.workspace_id
               where m.user_id = u.id and w.organisation_id = om.organisation_id) as seats
        from organisation_membership om
        join user_account u on u.id = om.user_id
       order by om.state, lower(u.name), lower(u.email)
    `)
    return rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      name: row.name,
      orgRole: row.org_role,
      state: row.state,
      linked: row.google_sub !== null && !row.google_sub.startsWith('dev:'),
      joinedAt: new Date(row.created_at),
      deactivatedAt: row.deactivated_at ? new Date(row.deactivated_at) : null,
      seats: row.seats ?? [],
    }))
  })

export type PendingInvitation = {
  id: string
  email: string
  orgRole: OrgRole
  workspaceId: string | null
  workspaceName: string | null
  workspaceRole: Role | null
  invitedByName: string | null
  expiresAt: Date
  createdAt: Date
}

export const listInvitations = async (ctx: OrganisationContext): Promise<PendingInvitation[]> =>
  withOrganisation(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      email: string
      org_role: OrgRole
      workspace_id: string | null
      workspace_name: string | null
      workspace_role: Role | null
      invited_by_name: string | null
      expires_at: Date
      created_at: Date
    }>(sql`
      select i.id, i.email, i.org_role, i.workspace_id, w.name as workspace_name,
             i.workspace_role, u.name as invited_by_name, i.expires_at, i.created_at
        from invitation i
        left join workspace w on w.id = i.workspace_id
        left join user_account u on u.id = i.invited_by
       where i.accepted_at is null and i.revoked_at is null
       order by i.created_at desc
    `)
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      orgRole: row.org_role,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      workspaceRole: row.workspace_role,
      invitedByName: row.invited_by_name,
      expiresAt: new Date(row.expires_at),
      createdAt: new Date(row.created_at),
    }))
  })

/** How long a link stays good. Long enough to survive a holiday, short enough that
 *  a forwarded mail from last quarter is not a way in. */
const INVITE_DAYS = 14

const assertRole = (role: string): Role => {
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`"${role}" is not a role.`)
  return role as Role
}

const seatsUsed = async (tx: Tx): Promise<{ used: number; limit: number | null }> => {
  const [row] = await tx.execute<{ used: number; seat_limit: number | null }>(sql`
    select (select count(*) from organisation_membership where state <> 'deactivated')::int as used,
           (select seat_limit from organisation limit 1) as seat_limit
  `)
  return { used: Number(row?.used ?? 0), limit: row?.seat_limit === null || row?.seat_limit === undefined ? null : Number(row.seat_limit) }
}

/** Creates the invitation and returns the raw token exactly once. Only the hash is
 *  stored, so the row is not itself a working link. */
export const invite = async (
  ctx: OrganisationContext,
  input: {
    email: string
    orgRole?: OrgRole | undefined
    workspaceId?: string | null | undefined
    workspaceRole?: string | null | undefined
  },
): Promise<{ token: string; id: string }> =>
  mutateOrg(ctx, 'invite somebody', async (tx) => {
    const email = input.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That is not an email address.')

    const seats = await seatsUsed(tx)
    if (seats.limit !== null && seats.used >= seats.limit) {
      throw new Error(`All ${seats.limit} seats are taken. Deactivate somebody, or raise the limit first.`)
    }

    const workspaceRole = input.workspaceRole ? assertRole(input.workspaceRole) : null
    if (input.workspaceId && !workspaceRole) throw new Error('Say which role the workspace seat carries.')

    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
    const tokenHash = await hashToken(token)
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000)

    const [created] = await tx
      .insert(invitation)
      .values({
        organisationId: ctx.organisationId,
        workspaceId: input.workspaceId ?? null,
        email,
        workspaceRole,
        orgRole: input.orgRole ?? 'member',
        tokenHash,
        invitedBy: ctx.actorId,
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: invitation.id })
    if (!created) throw new Error(`${email} already has an open invitation. Revoke it first, or resend that one.`)

    return {
      result: { token, id: created.id },
      audit: { entity: 'invitation', entityId: created.id, action: 'invite', after: { email, orgRole: input.orgRole ?? 'member' } },
    }
  })

/** A new link for the same seat: the old hash stops working, which is what makes
 *  resending safe when the first mail went to a spam folder. */
export const resendInvitation = async (
  ctx: OrganisationContext,
  invitationId: string,
): Promise<{ token: string }> =>
  mutateOrg(ctx, 'resend an invitation', async (tx) => {
    const [row] = await tx
      .select({ id: invitation.id, email: invitation.email })
      .from(invitation)
      .where(and(eq(invitation.id, invitationId), isNull(invitation.acceptedAt), isNull(invitation.revokedAt)))
    if (!row) throw new Error('That invitation has already been accepted or revoked.')
    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')
    await tx
      .update(invitation)
      .set({ tokenHash: await hashToken(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) })
      .where(eq(invitation.id, invitationId))
    return {
      result: { token },
      audit: { entity: 'invitation', entityId: invitationId, action: 'resend', after: { email: row.email } },
    }
  })

export const revokeInvitation = async (ctx: OrganisationContext, invitationId: string): Promise<void> =>
  mutateOrg(ctx, 'revoke an invitation', async (tx) => {
    const [row] = await tx
      .update(invitation)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitation.id, invitationId), isNull(invitation.acceptedAt), isNull(invitation.revokedAt)))
      .returning({ email: invitation.email })
    if (!row) throw new Error('That invitation has already been accepted or revoked.')
    return {
      result: undefined,
      audit: { entity: 'invitation', entityId: invitationId, action: 'revoke', before: { email: row.email } },
    }
  })

export const hashToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const orgAdminCount = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from organisation_membership where role = 'org_admin' and state = 'active'`,
  )
  return Number(row?.n ?? 0)
}

export const setOrgRole = async (
  ctx: OrganisationContext,
  input: { userId: string; role: OrgRole },
): Promise<void> =>
  mutateOrg(ctx, 'change what somebody administers', async (tx) => {
    const [current] = await tx
      .select({ role: organisationMembership.role, state: organisationMembership.state })
      .from(organisationMembership)
      .where(eq(organisationMembership.userId, input.userId))
    if (!current) throw new Error('That person is not in this organisation.')
    if (current.role === 'org_admin' && input.role !== 'org_admin' && (await orgAdminCount(tx)) <= 1) {
      throw new Error('This is the only organisation admin. Make somebody else one first.')
    }
    await tx
      .update(organisationMembership)
      .set({ role: input.role })
      .where(eq(organisationMembership.userId, input.userId))
    return {
      result: undefined,
      audit: {
        entity: 'organisation_membership',
        entityId: input.userId,
        action: 'set_org_role',
        before: { role: current.role },
        after: { role: input.role },
      },
    }
  })

/** Ends somebody's access everywhere at once. The row stays, so the audit trail
 *  still names them, and their memberships stop answering because
 *  `memberships_for_user` only returns active ones. Their sessions are cut on the
 *  same call rather than left to expire. */
export const deactivateMember = async (ctx: OrganisationContext, userId: string): Promise<void> =>
  mutateOrg(ctx, "end somebody's access", async (tx) => {
    if (userId === ctx.actorId) throw new Error('You cannot deactivate yourself. Ask another admin.')
    const [current] = await tx
      .select({ role: organisationMembership.role, state: organisationMembership.state })
      .from(organisationMembership)
      .where(eq(organisationMembership.userId, userId))
    if (!current) throw new Error('That person is not in this organisation.')
    if (current.state === 'deactivated') throw new Error('Their access has already ended.')
    if (current.role === 'org_admin' && (await orgAdminCount(tx)) <= 1) {
      throw new Error('This is the only organisation admin. Make somebody else one first.')
    }
    await tx
      .update(organisationMembership)
      .set({ state: 'deactivated', deactivatedAt: new Date(), deactivatedBy: ctx.actorId })
      .where(eq(organisationMembership.userId, userId))
    await tx.execute(sql`select rawr.sign_out_everywhere(${userId})`)
    return {
      result: undefined,
      audit: {
        entity: 'organisation_membership',
        entityId: userId,
        action: 'deactivate',
        before: { state: current.state },
      },
    }
  })

export const reactivateMember = async (ctx: OrganisationContext, userId: string): Promise<void> =>
  mutateOrg(ctx, 'restore somebody', async (tx) => {
    const seats = await seatsUsed(tx)
    if (seats.limit !== null && seats.used >= seats.limit) {
      throw new Error(`All ${seats.limit} seats are taken. Raise the limit first.`)
    }
    const [row] = await tx
      .update(organisationMembership)
      .set({ state: 'active', deactivatedAt: null, deactivatedBy: null })
      .where(and(eq(organisationMembership.userId, userId), eq(organisationMembership.state, 'deactivated')))
      .returning({ id: organisationMembership.id })
    if (!row) throw new Error('That person is not deactivated.')
    return {
      result: undefined,
      audit: { entity: 'organisation_membership', entityId: userId, action: 'reactivate' },
    }
  })

export type OrgAuditRow = {
  id: string
  at: Date
  actorName: string | null
  entity: string
  entityId: string | null
  action: string
  after: unknown
}

export const listOrgAudit = async (
  ctx: OrganisationContext,
  input: { limit?: number | undefined } = {},
): Promise<OrgAuditRow[]> =>
  withOrganisation(ctx, async (tx) => {
    assertOrgAdmin(ctx, 'read the organisation history')
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200)
    const rows = await tx
      .select({
        id: organisationAuditLog.id,
        at: organisationAuditLog.at,
        actorName: userAccount.name,
        entity: organisationAuditLog.entity,
        entityId: organisationAuditLog.entityId,
        action: organisationAuditLog.action,
        after: organisationAuditLog.after,
      })
      .from(organisationAuditLog)
      .leftJoin(userAccount, eq(userAccount.id, organisationAuditLog.actorId))
      .orderBy(desc(organisationAuditLog.at), desc(organisationAuditLog.id))
      .limit(limit)
    return rows
  })

/** Redeeming a link. Runs outside every scope, because the person clicking it has
 *  no session yet: the security-definer function is what makes that safe, and it
 *  refuses any token whose address is not the one signing in. */
export const acceptInvitation = async (token: string, userId: string): Promise<string | null> => {
  const [row] = await appDb.execute<{ id: string | null }>(
    sql`select rawr.accept_invitation(${await hashToken(token)}::text, ${userId}::uuid) as id`,
  )
  return row?.id ?? null
}

/** What the invitation page shows before anybody signs in: enough to say who is
 *  inviting whom, and nothing that identifies anyone else. */
export type InvitationOffer = {
  email: string
  organisationName: string
  workspaceName: string | null
  expired: boolean
}

export const readInvitationOffer = async (token: string): Promise<InvitationOffer | null> => {
  // Through a security-definer function for the same reason sign-in is: the page
  // runs before there is any scope to pin, so the table's own policy would
  // correctly show nothing.
  const [row] = await appDb.execute<{
    email: string
    organisation_name: string
    workspace_name: string | null
    expired: boolean
  }>(sql`select * from rawr.invitation_offer(${await hashToken(token)}::text)`)
  if (!row) return null
  return {
    email: row.email,
    organisationName: row.organisation_name,
    workspaceName: row.workspace_name,
    expired: row.expired,
  }
}
