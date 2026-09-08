import { asc, eq, sql } from 'drizzle-orm'
import { membership, userAccount } from '../schema/identity.ts'
import { HUBS, type AccountContext, type Hub, assertSuperAdmin } from './context.ts'
import { mutate, withAccount, type Tx } from './index.ts'

/** Who is in this account and what they hold, as HubSpot's grid puts it: a hub at
 *  a time, at view or edit, with super admin above the grid rather than in it.
 *
 *  The invariant every write protects: an account always keeps at least one super
 *  admin, because the alternative is a tenant nobody can administer. */

export type MemberRow = {
  userId: string
  email: string
  name: string
  avatarUrl: string | null
  isSuperAdmin: boolean
  viewHubs: Hub[]
  editHubs: Hub[]
  state: 'active' | 'invited' | 'deactivated'
  /** False until the person has signed in with Google at least once. */
  linked: boolean
  joinedAt: Date
}

export const listMembers = async (ctx: AccountContext): Promise<MemberRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx
      .select({
        userId: userAccount.id,
        email: userAccount.email,
        name: userAccount.name,
        avatarUrl: userAccount.avatarUrl,
        googleSub: userAccount.googleSub,
        isSuperAdmin: membership.isSuperAdmin,
        viewHubs: membership.viewHubs,
        editHubs: membership.editHubs,
        state: membership.state,
        joinedAt: membership.createdAt,
      })
      .from(membership)
      .innerJoin(userAccount, eq(userAccount.id, membership.userId))
      .orderBy(asc(userAccount.name), asc(userAccount.email))
    return rows.map(({ googleSub, ...row }) => ({
      ...row,
      linked: googleSub !== null && !googleSub.startsWith('dev:'),
    }))
  })

const superAdminCount = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from membership where is_super_admin and state = 'active'`,
  )
  return Number(row?.n ?? 0)
}

const assertHubs = (hubs: readonly string[]): Hub[] => {
  for (const hub of hubs) {
    if (!(HUBS as readonly string[]).includes(hub)) throw new Error(`"${hub}" is not a hub.`)
  }
  return hubs as Hub[]
}

export type Grants = {
  isSuperAdmin?: boolean | undefined
  viewHubs?: readonly string[] | undefined
  editHubs?: readonly string[] | undefined
}

const toGrants = (input: Grants) => ({
  isSuperAdmin: input.isSuperAdmin ?? false,
  viewHubs: assertHubs(input.viewHubs ?? []),
  editHubs: assertHubs(input.editHubs ?? []),
})

export const addMember = async (
  ctx: AccountContext,
  input: { email: string; name?: string | null | undefined } & Grants,
): Promise<{ userId: string }> =>
  mutate(ctx, 'membership', async (tx) => {
    assertSuperAdmin(ctx, 'seat somebody in this account')
    const email = input.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That is not an email address.')
    const grants = toGrants(input)
    const [row] = await tx.execute<{ id: string }>(
      sql`select rawr.add_member(${email}, ${input.name ?? ''},
            ${sql.raw(`ARRAY[${grants.viewHubs.map((h) => `'${h}'`).join(',')}]::rawr_hub[]`)},
            ${sql.raw(`ARRAY[${grants.editHubs.map((h) => `'${h}'`).join(',')}]::rawr_hub[]`)}) as id`,
    )
    if (!row) throw new Error('The member was not added.')
    if (grants.isSuperAdmin) {
      await tx.update(membership).set({ isSuperAdmin: true }).where(eq(membership.userId, row.id))
    }
    return {
      result: { userId: row.id },
      audit: { entity: 'membership', entityId: row.id, action: 'add', after: { email, ...grants } },
    }
  })

export const setMemberGrants = async (
  ctx: AccountContext,
  input: { userId: string } & Grants,
): Promise<void> =>
  mutate(ctx, 'membership', async (tx) => {
    assertSuperAdmin(ctx, "change somebody's access")
    const grants = toGrants(input)
    const [current] = await tx
      .select({
        isSuperAdmin: membership.isSuperAdmin,
        viewHubs: membership.viewHubs,
        editHubs: membership.editHubs,
      })
      .from(membership)
      .where(eq(membership.userId, input.userId))
    if (!current) throw new Error('That person is not a member of this account.')
    if (current.isSuperAdmin && !grants.isSuperAdmin && (await superAdminCount(tx)) <= 1) {
      throw new Error('This is the only super admin. Make somebody else one first.')
    }
    await tx.update(membership).set(grants).where(eq(membership.userId, input.userId))
    return {
      result: undefined,
      audit: {
        entity: 'membership',
        entityId: input.userId,
        action: 'set_grants',
        before: current,
        after: grants,
      },
    }
  })

export const removeMember = async (ctx: AccountContext, userId: string): Promise<void> =>
  mutate(ctx, 'membership', async (tx) => {
    assertSuperAdmin(ctx, "end somebody's access")
    if (userId === ctx.actorId) {
      throw new Error('You cannot remove yourself. Ask another super admin to do it.')
    }
    const [current] = await tx
      .select({ isSuperAdmin: membership.isSuperAdmin })
      .from(membership)
      .where(eq(membership.userId, userId))
    if (!current) throw new Error('That person is not a member of this account.')
    if (current.isSuperAdmin && (await superAdminCount(tx)) <= 1) {
      throw new Error('This is the only super admin. Make somebody else one first.')
    }
    await tx.delete(membership).where(eq(membership.userId, userId))
    return {
      result: undefined,
      audit: { entity: 'membership', entityId: userId, action: 'remove', before: current },
    }
  })
