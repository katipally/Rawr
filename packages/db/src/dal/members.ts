import { asc, eq, sql } from 'drizzle-orm'
import { membership, userAccount } from '../schema/identity.ts'
import { ROLES, type Role, type WorkspaceContext } from './context.ts'
import { mutate, withWorkspace, type Tx } from './index.ts'

/** Who is in this workspace and what they may do. Four fixed roles, D5.
 *
 *  The invariant every write protects: a workspace always keeps at least one
 *  admin, because the alternative is a tenant nobody can administer. */

export type MemberRow = {
  userId: string
  email: string
  name: string
  avatarUrl: string | null
  role: Role
  /** Null until the person has signed in with Google at least once. */
  linked: boolean
  joinedAt: Date
}

export const listMembers = async (ctx: WorkspaceContext): Promise<MemberRow[]> =>
  withWorkspace(ctx, async (tx) => {
    const rows = await tx
      .select({
        userId: userAccount.id,
        email: userAccount.email,
        name: userAccount.name,
        avatarUrl: userAccount.avatarUrl,
        googleSub: userAccount.googleSub,
        role: membership.role,
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

const adminCount = async (tx: Tx): Promise<number> => {
  const [row] = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from membership where role = 'admin'`,
  )
  return Number(row?.n ?? 0)
}

const assertRole = (role: string): Role => {
  if (!(ROLES as readonly string[]).includes(role)) throw new Error(`"${role}" is not a role.`)
  return role as Role
}

export const addMember = async (
  ctx: WorkspaceContext,
  input: { email: string; name?: string | null | undefined; role: string },
): Promise<{ userId: string }> =>
  mutate(ctx, 'membership', async (tx) => {
    const email = input.email.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('That is not an email address.')
    const role = assertRole(input.role)
    const [row] = await tx.execute<{ id: string }>(
      sql`select rawr.add_member(${email}, ${input.name ?? ''}, ${role}::rawr_role) as id`,
    )
    if (!row) throw new Error('The member was not added.')
    return {
      result: { userId: row.id },
      audit: { entity: 'membership', entityId: row.id, action: 'add', after: { email, role } },
    }
  })

export const setMemberRole = async (
  ctx: WorkspaceContext,
  input: { userId: string; role: string },
): Promise<void> =>
  mutate(ctx, 'membership', async (tx) => {
    const role = assertRole(input.role)
    const [current] = await tx
      .select({ role: membership.role })
      .from(membership)
      .where(eq(membership.userId, input.userId))
    if (!current) throw new Error('That person is not a member of this workspace.')
    if (current.role === 'admin' && role !== 'admin' && (await adminCount(tx)) <= 1) {
      throw new Error('This is the only admin. Make somebody else an admin first.')
    }
    await tx.update(membership).set({ role }).where(eq(membership.userId, input.userId))
    return {
      result: undefined,
      audit: {
        entity: 'membership',
        entityId: input.userId,
        action: 'set_role',
        before: { role: current.role },
        after: { role },
      },
    }
  })

export const removeMember = async (ctx: WorkspaceContext, userId: string): Promise<void> =>
  mutate(ctx, 'membership', async (tx) => {
    if (userId === ctx.actorId) {
      throw new Error('You cannot remove yourself. Ask another admin to do it.')
    }
    const [current] = await tx
      .select({ role: membership.role })
      .from(membership)
      .where(eq(membership.userId, userId))
    if (!current) throw new Error('That person is not a member of this workspace.')
    if (current.role === 'admin' && (await adminCount(tx)) <= 1) {
      throw new Error('This is the only admin. Make somebody else an admin first.')
    }
    await tx.delete(membership).where(eq(membership.userId, userId))
    return {
      result: undefined,
      audit: { entity: 'membership', entityId: userId, action: 'remove', before: { role: current.role } },
    }
  })
