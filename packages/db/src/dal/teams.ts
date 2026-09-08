import { eq, sql } from 'drizzle-orm'
import { team, teamMember } from '../schema/identity.ts'
import type { AccountContext } from './context.ts'
import { mutate, withAccount } from './index.ts'

/** A named group inside one account. Round robin assignment rotates within a
 *  team, which is what lets a form hand European leads to the people who work
 *  them rather than to whoever happens to own the fewest contacts overall. */

export type TeamRow = {
  id: string
  name: string
  description: string | null
  members: { userId: string; name: string; email: string; isLead: boolean }[]
}

export const listTeams = async (ctx: AccountContext): Promise<TeamRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      name: string
      description: string | null
      members: { userId: string; name: string; email: string; isLead: boolean }[] | null
    }>(sql`
      select t.id, t.name, t.description,
             (select json_agg(json_build_object('userId', u.id, 'name', u.name, 'email', u.email,
                                                'isLead', tm.is_lead)
                              order by tm.is_lead desc, lower(u.name))
                from team_member tm join user_account u on u.id = tm.user_id
               where tm.team_id = t.id) as members
        from team t
       order by lower(t.name)
    `)
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      members: row.members ?? [],
    }))
  })

export const saveTeam = async (
  ctx: AccountContext,
  input: { id?: string | null | undefined; name: string; description?: string | null | undefined },
): Promise<{ id: string }> =>
  mutate(ctx, 'team', async (tx) => {
    const name = input.name.trim()
    if (name === '') throw new Error('A team needs a name.')
    if (input.id) {
      const [row] = await tx
        .update(team)
        .set({ name, description: input.description ?? null })
        .where(eq(team.id, input.id))
        .returning({ id: team.id })
      if (!row) throw new Error('That team is not in this account.')
      return { result: { id: row.id }, audit: { entity: 'team', entityId: row.id, action: 'update', after: { name } } }
    }
    const [row] = await tx
      .insert(team)
      .values({ accountId: ctx.accountId, name, description: input.description ?? null })
      .onConflictDoNothing()
      .returning({ id: team.id })
    if (!row) throw new Error(`This account already has a team called "${name}".`)
    return { result: { id: row.id }, audit: { entity: 'team', entityId: row.id, action: 'create', after: { name } } }
  })

export const deleteTeam = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'team', async (tx) => {
    const [row] = await tx.delete(team).where(eq(team.id, id)).returning({ name: team.name })
    if (!row) throw new Error('That team is not in this account.')
    return { result: undefined, audit: { entity: 'team', entityId: id, action: 'delete', before: row } }
  })

/** The whole membership at once. A team is small and the list is edited as a set,
 *  so replacing it is one statement rather than a diff nobody can read. */
export const setTeamMembers = async (
  ctx: AccountContext,
  input: { teamId: string; members: { userId: string; isLead?: boolean | undefined }[] },
): Promise<void> =>
  mutate(ctx, 'team_member', async (tx) => {
    const [exists] = await tx.select({ id: team.id }).from(team).where(eq(team.id, input.teamId))
    if (!exists) throw new Error('That team is not in this account.')
    await tx.delete(teamMember).where(eq(teamMember.teamId, input.teamId))
    if (input.members.length > 0) {
      await tx.insert(teamMember).values(
        input.members.map((member) => ({
          accountId: ctx.accountId,
          teamId: input.teamId,
          userId: member.userId,
          isLead: member.isLead ?? false,
        })),
      )
    }
    return {
      result: undefined,
      audit: {
        entity: 'team_member',
        entityId: input.teamId,
        action: 'set_members',
        after: { count: input.members.length },
      },
    }
  })

/** Who can be put on a team: everybody seated in this account. */
export const listAssignable = async (
  ctx: AccountContext,
): Promise<{ userId: string; name: string; email: string }[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ user_id: string; name: string; email: string }>(sql`
      select u.id as user_id, u.name, u.email
        from membership m join user_account u on u.id = m.user_id
       order by lower(u.name)
    `)
    return rows.map((row) => ({ userId: row.user_id, name: row.name, email: row.email }))
  })
