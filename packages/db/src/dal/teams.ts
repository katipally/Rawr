import { and, eq, notInArray, sql } from 'drizzle-orm'
import { team, teamMember } from '../schema/identity.ts'
import type { AccountContext } from './context.ts'
import { mutate, withAccount, type Tx } from './index.ts'

/** A named group of people inside one account. A form or a booking page can hand its
 *  work to a team: the team's seated members take it in turn, least recently
 *  picked first. Teams are edited here; the turns are taken by `takeTeamTurn`. */

export type TeamMemberRow = {
  userId: string
  name: string
  email: string
  isLead: boolean
  /** False once the person is deactivated. Kept on the team, but never picked. */
  seated: boolean
  lastAssignedAt: string | null
}

export type TeamRow = {
  id: string
  name: string
  description: string | null
  members: TeamMemberRow[]
  /** Forms and booking pages that take their work from this team. */
  formCount: number
  bookingPageCount: number
}

export const listTeams = async (ctx: AccountContext): Promise<TeamRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      name: string
      description: string | null
      members: TeamMemberRow[] | null
      form_count: string
      booking_page_count: string
    }>(sql`
      with form_uses as (
        select f.settings #>> '{assignOwner,teamId}' as team_id, count(*) as n
          from form f where f.settings #>> '{assignOwner,mode}' = 'team'
         group by 1),
      booking_uses as (
        select p.team_id::text as team_id, count(*) as n
          from booking_page p where p.team_id is not null
         group by 1)
      select t.id, t.name, t.description,
             (select json_agg(json_build_object('userId', u.id, 'name', u.name, 'email', u.email,
                                                'isLead', tm.is_lead, 'seated', m.state <> 'deactivated',
                                                'lastAssignedAt', tm.last_assigned_at)
                              order by tm.is_lead desc, lower(u.name))
                from team_member tm
                join user_account u on u.id = tm.user_id
                left join membership m on m.user_id = tm.user_id and m.account_id = tm.account_id
               where tm.team_id = t.id) as members,
             coalesce(fu.n, 0) as form_count,
             coalesce(bu.n, 0) as booking_page_count
        from team t
        left join form_uses fu on fu.team_id = t.id::text
        left join booking_uses bu on bu.team_id = t.id::text
       order by lower(t.name)
    `)
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      members: row.members ?? [],
      formCount: Number(row.form_count),
      bookingPageCount: Number(row.booking_page_count),
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

/** The whole membership at once. Whoever stays keeps their place in the rotation:
 *  only the rows that left are deleted, and a member who stays is updated in place. */
export const setTeamMembers = async (
  ctx: AccountContext,
  input: { teamId: string; members: { userId: string; isLead?: boolean | undefined }[] },
): Promise<void> =>
  mutate(ctx, 'team_member', async (tx) => {
    const [exists] = await tx.select({ id: team.id }).from(team).where(eq(team.id, input.teamId))
    if (!exists) throw new Error('That team is not in this account.')
    const kept = input.members.map((member) => member.userId)
    await tx.delete(teamMember).where(
      kept.length > 0
        ? and(eq(teamMember.teamId, input.teamId), notInArray(teamMember.userId, kept))
        : eq(teamMember.teamId, input.teamId),
    )
    if (input.members.length > 0) {
      await tx
        .insert(teamMember)
        .values(
          input.members.map((member) => ({
            accountId: ctx.accountId,
            teamId: input.teamId,
            userId: member.userId,
            isLead: member.isLead ?? false,
          })),
        )
        .onConflictDoUpdate({
          target: [teamMember.teamId, teamMember.userId],
          set: { isLead: sql`excluded.is_lead` },
        })
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

/** Who can be put on a team: everybody still seated in this account. A
 *  deactivated member keeps the row but must not take a turn in the rotation. */
export const listAssignable = async (
  ctx: AccountContext,
): Promise<{ userId: string; name: string; email: string }[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{ user_id: string; name: string; email: string }>(sql`
      select u.id as user_id, u.name, u.email
        from membership m join user_account u on u.id = m.user_id
       where m.state <> 'deactivated'
       order by lower(u.name)
    `)
    return rows.map((row) => ({ userId: row.user_id, name: row.name, email: row.email }))
  })

/** The member whose turn it is: somebody never picked first, then the one picked
 *  longest ago, ties broken by user id so the same members always give the same
 *  answer. One pass over the list, O(members). */
export const leastRecentlyAssigned = (
  members: { userId: string; lastAssignedAt: Date | null }[],
): string | null => {
  let best: { userId: string; at: number } | null = null
  for (const member of members) {
    const at = member.lastAssignedAt?.getTime() ?? -Infinity
    if (!best || at < best.at || (at === best.at && member.userId < best.userId)) {
      best = { userId: member.userId, at }
    }
  }
  return best?.userId ?? null
}

/** Takes the next turn of a team's rotation and records it, inside the caller's
 *  transaction. `among` narrows the pool to the members who are free for this
 *  turn (a booking), or null for every seated member (a form lead).
 *
 *  Two picks at the same instant must not take the same person. Locking the team
 *  row serialises every pick on that team: the second waits for the first to
 *  commit, then reads the turns the first one wrote. Locking the picked member row
 *  instead (SKIP LOCKED) would not be enough under READ COMMITTED, because a row
 *  committed after the scan started can still be read at its old value. The team
 *  lock is held for the caller's transaction only, which is a handful of statements.
 *
 *  Null when the team is gone or nobody in the pool is seated. Cost is one lock,
 *  one read over the team's members (served by the unique team and user index),
 *  and one update by primary key. */
export const takeTeamTurn = async (
  tx: Tx,
  teamId: string,
  among: string[] | null,
): Promise<string | null> => {
  if (among?.length === 0) return null
  const [locked] = await tx.execute<{ id: string }>(
    sql`select id from team where id = ${teamId} for update`,
  )
  if (!locked) return null

  const pool = among
    ? sql`and tm.user_id in (${sql.join(among.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql``
  const rows = await tx.execute<{ user_id: string; last_assigned_at: Date | string | null }>(sql`
    select tm.user_id, tm.last_assigned_at
      from team_member tm
      join membership m on m.user_id = tm.user_id and m.account_id = tm.account_id
     where tm.team_id = ${teamId} and m.state <> 'deactivated' ${pool}`)

  const chosen = leastRecentlyAssigned(
    rows.map((row) => ({
      userId: row.user_id,
      lastAssignedAt: row.last_assigned_at === null ? null : new Date(row.last_assigned_at),
    })),
  )
  if (!chosen) return null
  await tx.execute(sql`
    update team_member set last_assigned_at = clock_timestamp()
     where team_id = ${teamId} and user_id = ${chosen}::uuid`)
  return chosen
}
