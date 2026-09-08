import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import { account, invitation, membership, userAccount } from '../schema/identity.ts'
import { HUBS, type AccountContext, type Hub, assertSuperAdmin } from './context.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import { provisionAccount } from './provision.ts'

/** The account as a thing to administer rather than a thing to keep records in:
 *  its name, its domain, its seats, who holds one and who has been offered one.
 *
 *  All of it runs in the ordinary account scope. There used to be a second
 *  connection setting and a second set of policies for the company above the
 *  workspace; with one tenant there is no second question to ask. */

export type MemberState = 'active' | 'invited' | 'deactivated'

export type Account = {
  id: string
  name: string
  slug: string
  hostedDomain: string
  autoJoinHostedDomain: boolean
  defaultViewHubs: Hub[]
  seatLimit: number | null
  seatsUsed: number
  activityRetentionMonths: number
}

export const readAccount = async (ctx: AccountContext): Promise<Account> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{
      id: string
      name: string
      slug: string
      google_hosted_domain: string
      auto_join_hosted_domain: boolean
      default_view_hubs: Hub[]
      seat_limit: number | null
      seats_used: number
      activity_retention_months: number
    }>(sql`
      select a.*,
             (select count(*) from membership m
               where m.account_id = a.id and m.state <> 'deactivated')::int as seats_used
        from account a
       limit 1
    `)
    if (!row) throw new Error('That account no longer exists.')
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      hostedDomain: row.google_hosted_domain,
      autoJoinHostedDomain: row.auto_join_hosted_domain,
      defaultViewHubs: row.default_view_hubs ?? [],
      seatLimit: row.seat_limit === null ? null : Number(row.seat_limit),
      seatsUsed: Number(row.seats_used),
      activityRetentionMonths: Number(row.activity_retention_months),
    }
  })

const assertHubs = (hubs: readonly string[]): Hub[] => {
  for (const hub of hubs) {
    if (!(HUBS as readonly string[]).includes(hub)) throw new Error(`"${hub}" is not a hub.`)
  }
  return hubs as Hub[]
}

export const saveAccount = async (
  ctx: AccountContext,
  input: {
    name?: string | undefined
    autoJoinHostedDomain?: boolean | undefined
    defaultViewHubs?: readonly string[] | undefined
    seatLimit?: number | null | undefined
    activityRetentionMonths?: number | undefined
  },
): Promise<void> =>
  mutate(ctx, 'account', async (tx) => {
    assertSuperAdmin(ctx, 'change the account')
    const [before] = await tx.select().from(account).limit(1)
    if (!before) throw new Error('That account no longer exists.')
    const name = input.name?.trim()
    if (name !== undefined && name === '') throw new Error('An account needs a name.')
    if (input.seatLimit !== undefined && input.seatLimit !== null && input.seatLimit < 1) {
      throw new Error('A seat limit is at least one.')
    }
    const months = input.activityRetentionMonths
    if (months !== undefined && (!Number.isInteger(months) || months < 1 || months > 120)) {
      throw new Error('An activity retention window is a whole number of months between 1 and 120.')
    }
    const hubs = input.defaultViewHubs === undefined ? undefined : assertHubs(input.defaultViewHubs)
    await tx
      .update(account)
      .set({
        ...(name === undefined ? {} : { name }),
        ...(input.autoJoinHostedDomain === undefined ? {} : { autoJoinHostedDomain: input.autoJoinHostedDomain }),
        ...(hubs === undefined ? {} : { defaultViewHubs: hubs }),
        ...(input.seatLimit === undefined ? {} : { seatLimit: input.seatLimit }),
        ...(months === undefined ? {} : { activityRetentionMonths: months }),
      })
      .where(eq(account.id, ctx.accountId))
    return {
      result: undefined,
      audit: { entity: 'account', entityId: ctx.accountId, action: 'update', before, after: input },
    }
  })

export type PendingInvitation = {
  id: string
  email: string
  isSuperAdmin: boolean
  viewHubs: Hub[]
  editHubs: Hub[]
  invitedByName: string | null
  expiresAt: Date
  createdAt: Date
}

export const listInvitations = async (ctx: AccountContext): Promise<PendingInvitation[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: invitation.id,
        email: invitation.email,
        isSuperAdmin: invitation.isSuperAdmin,
        viewHubs: invitation.viewHubs,
        editHubs: invitation.editHubs,
        invitedByName: userAccount.name,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
      })
      .from(invitation)
      .leftJoin(userAccount, eq(userAccount.id, invitation.invitedBy))
      .where(and(isNull(invitation.acceptedAt), isNull(invitation.revokedAt)))
      .orderBy(desc(invitation.createdAt))
    return rows
  })

/** How long a link stays good. Long enough to survive a holiday, short enough that
 *  a forwarded mail from last quarter is not a way in. */
const INVITE_DAYS = 14

const seatsUsed = async (tx: Tx): Promise<{ used: number; limit: number | null }> => {
  const [row] = await tx.execute<{ used: number; seat_limit: number | null }>(sql`
    select (select count(*) from membership where state <> 'deactivated')::int as used,
           (select seat_limit from account limit 1) as seat_limit
  `)
  const limit = row?.seat_limit
  return { used: Number(row?.used ?? 0), limit: limit === null || limit === undefined ? null : Number(limit) }
}

const newToken = (): string =>
  crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '')

/** Creates the invitation and returns the raw token exactly once. Only the hash is
 *  stored, so the row is not itself a working link. */
export const invite = async (
  ctx: AccountContext,
  input: {
    email: string
    isSuperAdmin?: boolean | undefined
    viewHubs?: readonly string[] | undefined
    editHubs?: readonly string[] | undefined
  },
): Promise<{ token: string; id: string }> =>
  mutate(ctx, 'invitation', async (tx) => {
    assertSuperAdmin(ctx, 'invite somebody')
    const email = input.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That is not an email address.')

    const seats = await seatsUsed(tx)
    if (seats.limit !== null && seats.used >= seats.limit) {
      throw new Error(`All ${seats.limit} seats are taken. Deactivate somebody, or raise the limit first.`)
    }

    const token = newToken()
    const [created] = await tx
      .insert(invitation)
      .values({
        accountId: ctx.accountId,
        email,
        isSuperAdmin: input.isSuperAdmin ?? false,
        viewHubs: assertHubs(input.viewHubs ?? []),
        editHubs: assertHubs(input.editHubs ?? []),
        tokenHash: await hashToken(token),
        invitedBy: ctx.actorId,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
      })
      .onConflictDoNothing()
      .returning({ id: invitation.id })
    if (!created) throw new Error(`${email} already has an open invitation. Revoke it first, or resend that one.`)

    return {
      result: { token, id: created.id },
      audit: { entity: 'invitation', entityId: created.id, action: 'invite', after: { email } },
    }
  })

/** A new link for the same seat: the old hash stops working, which is what makes
 *  resending safe when the first mail went to a spam folder. */
export const resendInvitation = async (
  ctx: AccountContext,
  invitationId: string,
): Promise<{ token: string }> =>
  mutate(ctx, 'invitation', async (tx) => {
    assertSuperAdmin(ctx, 'resend an invitation')
    const [row] = await tx
      .select({ id: invitation.id, email: invitation.email })
      .from(invitation)
      .where(and(eq(invitation.id, invitationId), isNull(invitation.acceptedAt), isNull(invitation.revokedAt)))
    if (!row) throw new Error('That invitation has already been accepted or revoked.')
    const token = newToken()
    await tx
      .update(invitation)
      .set({ tokenHash: await hashToken(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) })
      .where(eq(invitation.id, invitationId))
    return {
      result: { token },
      audit: { entity: 'invitation', entityId: invitationId, action: 'resend', after: { email: row.email } },
    }
  })

export const revokeInvitation = async (ctx: AccountContext, invitationId: string): Promise<void> =>
  mutate(ctx, 'invitation', async (tx) => {
    assertSuperAdmin(ctx, 'revoke an invitation')
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

const superAdminCount = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from membership where is_super_admin and state = 'active'`,
  )
  return Number(row?.n ?? 0)
}

/** Ends somebody's access. The row stays, so the audit trail still names them, and
 *  their membership stops answering because `memberships_for_user` only returns
 *  active ones. Their sessions are cut on the same call rather than left to
 *  expire. */
export const deactivateMember = async (ctx: AccountContext, userId: string): Promise<void> =>
  mutate(ctx, 'membership', async (tx) => {
    assertSuperAdmin(ctx, "end somebody's access")
    if (userId === ctx.actorId) throw new Error('You cannot deactivate yourself. Ask another super admin.')
    const [current] = await tx
      .select({ isSuperAdmin: membership.isSuperAdmin, state: membership.state })
      .from(membership)
      .where(eq(membership.userId, userId))
    if (!current) throw new Error('That person is not in this account.')
    if (current.state === 'deactivated') throw new Error('Their access has already ended.')
    if (current.isSuperAdmin && (await superAdminCount(tx)) <= 1) {
      throw new Error('This is the only super admin. Make somebody else one first.')
    }
    await tx
      .update(membership)
      .set({ state: 'deactivated', deactivatedAt: new Date(), deactivatedBy: ctx.actorId })
      .where(eq(membership.userId, userId))
    await tx.execute(sql`select rawr.sign_out_everywhere(${userId})`)
    return {
      result: undefined,
      audit: { entity: 'membership', entityId: userId, action: 'deactivate', before: { state: current.state } },
    }
  })

export const reactivateMember = async (ctx: AccountContext, userId: string): Promise<void> =>
  mutate(ctx, 'membership', async (tx) => {
    assertSuperAdmin(ctx, 'restore somebody')
    const seats = await seatsUsed(tx)
    if (seats.limit !== null && seats.used >= seats.limit) {
      throw new Error(`All ${seats.limit} seats are taken. Raise the limit first.`)
    }
    const [row] = await tx
      .update(membership)
      .set({ state: 'active', deactivatedAt: null, deactivatedBy: null })
      .where(and(eq(membership.userId, userId), eq(membership.state, 'deactivated')))
      .returning({ id: membership.id })
    if (!row) throw new Error('That person is not deactivated.')
    return {
      result: undefined,
      audit: { entity: 'membership', entityId: userId, action: 'reactivate' },
    }
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
  accountName: string
  expired: boolean
}

export const readInvitationOffer = async (token: string): Promise<InvitationOffer | null> => {
  // Through a security-definer function for the same reason sign-in is: the page
  // runs before there is any scope to pin, so the table's own policy would
  // correctly show nothing.
  const [row] = await appDb.execute<{ email: string; account_name: string; expired: boolean }>(
    sql`select * from rawr.invitation_offer(${await hashToken(token)}::text)`,
  )
  if (!row) return null
  return { email: row.email, accountName: row.account_name, expired: row.expired }
}

/** Whether a freshly opened account still needs its objects, fields, views and
 *  pipelines. The sign-in function creates the account; provisioning it is
 *  application code, so the callback asks this and then calls provisionAccount. */
export const accountNeedsProvisioning = async (accountId: string): Promise<boolean> => {
  const [row] = await appDb.execute<{ needs: boolean }>(
    sql`select rawr.account_needs_provisioning(${accountId}::uuid) as needs`,
  )
  return row?.needs ?? false
}

/** Gives a freshly opened account the objects, fields, views, pipelines and
 *  stages every screen falls back to. Runs in the new account's own scope with the
 *  grants its first member holds, so nothing here escapes the tenancy policy.
 *
 *  Idempotent by its guard rather than by its writes: provisioning twice would
 *  duplicate every object definition, so the caller asks first. */
export const provisionNewAccount = async (accountId: string, actorId: string): Promise<boolean> => {
  if (!(await accountNeedsProvisioning(accountId))) return false
  const ctx: AccountContext = {
    accountId,
    actorId,
    actorKind: 'user',
    isSuperAdmin: true,
    viewHubs: [],
    editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
  }
  await withAccount(ctx, (tx) => provisionAccount(tx, accountId))
  return true
}
