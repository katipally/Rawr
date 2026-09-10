import { asc, eq, sql } from 'drizzle-orm'
import { membership, userAccount } from '../schema/identity.ts'
import {
  HUBS,
  assertCriticalActions,
  assertScopes,
  assertSuperAdmin,
  type AccountContext,
  type CriticalAction,
  type Hub,
  type HubScopes,
} from './context.ts'
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
  viewScopes: HubScopes
  editScopes: HubScopes
  criticalGrants: CriticalAction[]
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
        viewScopes: membership.viewScopes,
        editScopes: membership.editScopes,
        criticalGrants: membership.criticalGrants,
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
  viewScopes?: Record<string, string> | undefined
  editScopes?: Record<string, string> | undefined
  criticalGrants?: readonly string[] | undefined
}

const toGrants = (input: Grants) => {
  const viewHubs = assertHubs(input.viewHubs ?? [])
  const editHubs = assertHubs(input.editHubs ?? [])
  return {
    isSuperAdmin: input.isSuperAdmin ?? false,
    viewHubs,
    editHubs,
    // A view scope covers what edit grants too, because canView unions the two.
    viewScopes: assertScopes(input.viewScopes, [...viewHubs, ...editHubs]),
    editScopes: assertScopes(input.editScopes, editHubs),
    criticalGrants: assertCriticalActions(input.criticalGrants),
  }
}

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
    // rawr.add_member seats the person and hands back the id; the rest of the
    // grant is applied here rather than widening that function's signature.
    await tx
      .update(membership)
      .set({
        isSuperAdmin: grants.isSuperAdmin,
        viewScopes: grants.viewScopes,
        editScopes: grants.editScopes,
        criticalGrants: grants.criticalGrants,
      })
      .where(eq(membership.userId, row.id))
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
        viewScopes: membership.viewScopes,
        editScopes: membership.editScopes,
        criticalGrants: membership.criticalGrants,
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

/** HubSpot's "Start with a template": a suggested set somebody adjusts before
 *  saving, not a role they are locked into. Applied by writing the grants out, so
 *  changing a template later never silently changes anybody's access.
 *
 *  Every template leaves `purge` out. Permanently deleting data is answered to a
 *  regulator, so it is granted to a named person rather than handed out with a job
 *  title. */
export const ROLE_TEMPLATES = {
  sales_rep: {
    label: 'Sales rep',
    description: 'Works contacts and deals, and reads the numbers.',
    grants: {
      isSuperAdmin: false,
      viewHubs: ['reports'],
      editHubs: ['contacts', 'sales'],
      viewScopes: {},
      editScopes: {},
      criticalGrants: ['delete', 'merge', 'export'],
    },
  },
  marketer: {
    label: 'Marketer',
    description: 'Runs forms, segments and the newsletter, and loads lists.',
    grants: {
      isSuperAdmin: false,
      viewHubs: ['sales', 'reports'],
      editHubs: ['contacts', 'marketing'],
      viewScopes: {},
      editScopes: {},
      criticalGrants: ['merge', 'import', 'export'],
    },
  },
  viewer: {
    label: 'Viewer',
    description: 'Reads everything the account has. Changes nothing.',
    grants: {
      isSuperAdmin: false,
      viewHubs: ['contacts', 'sales', 'marketing', 'reports'],
      editHubs: [],
      viewScopes: {},
      editScopes: {},
      criticalGrants: [],
    },
  },
} as const satisfies Record<
  string,
  {
    label: string
    description: string
    grants: {
      isSuperAdmin: boolean
      viewHubs: readonly Hub[]
      editHubs: readonly Hub[]
      viewScopes: HubScopes
      editScopes: HubScopes
      criticalGrants: readonly CriticalAction[]
    }
  }
>

export type RoleTemplateKey = keyof typeof ROLE_TEMPLATES

/** HubSpot's "copy another user's permissions". Read and written in one
 *  transaction so the copy is of what the source held at that instant, and audited
 *  on the person who changed rather than on the person copied from. */
export const copyMemberGrants = async (
  ctx: AccountContext,
  input: { fromUserId: string; toUserId: string },
): Promise<void> =>
  mutate(ctx, 'membership', async (tx) => {
    assertSuperAdmin(ctx, "change somebody's access")
    if (input.fromUserId === input.toUserId) throw new Error('That is the same person.')
    const [source, target] = await Promise.all([
      tx
        .select({
          isSuperAdmin: membership.isSuperAdmin,
          viewHubs: membership.viewHubs,
          editHubs: membership.editHubs,
          viewScopes: membership.viewScopes,
          editScopes: membership.editScopes,
          criticalGrants: membership.criticalGrants,
        })
        .from(membership)
        .where(eq(membership.userId, input.fromUserId)),
      tx
        .select({ isSuperAdmin: membership.isSuperAdmin })
        .from(membership)
        .where(eq(membership.userId, input.toUserId)),
    ])
    const from = source[0]
    const to = target[0]
    if (!from) throw new Error('The person you are copying from is not a member of this account.')
    if (!to) throw new Error('That person is not a member of this account.')
    if (to.isSuperAdmin && !from.isSuperAdmin && (await superAdminCount(tx)) <= 1) {
      throw new Error('This is the only super admin. Make somebody else one first.')
    }
    await tx.update(membership).set(from).where(eq(membership.userId, input.toUserId))
    return {
      result: undefined,
      audit: {
        entity: 'membership',
        entityId: input.toUserId,
        action: 'copy_grants',
        before: to,
        after: { ...from, copiedFrom: input.fromUserId },
      },
    }
  })
