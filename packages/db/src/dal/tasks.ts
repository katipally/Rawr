import { and, asc, eq, isNotNull, lt, sql } from 'drizzle-orm'
import { task } from '../schema/records.ts'
import { userAccount } from '../schema/identity.ts'
import { recordActivity, type EntityRef } from './activity.ts'
import type { WorkspaceContext } from './context.ts'
import { refreshEmailEngagement } from './engagement.ts'
import { mutate, withWorkspace, type Tx } from './index.ts'
// A sequence step can make a task, and completing that task resumes the sequence.
// The two modules import each other for exactly that pair of calls; Node resolves
// the cycle because neither reads the other at module scope.
import { onTaskDone } from './sequences.ts'

export type TaskRow = {
  id: string
  title: string
  body: string | null
  dueDate: string | null
  status: 'open' | 'done'
  assigneeName: string | null
  assigneeId: string | null
  entityType: 'company' | 'contact' | 'deal' | null
  entityId: string | null
  entityName: string | null
}

const ENTITY_NAME = sql<string | null>`case
  when ${task.entityType} = 'contact' then (select coalesce(nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), ''), c.email) from contact c where c.id = ${task.entityId})
  when ${task.entityType} = 'company' then (select coalesce(co.name, co.domain) from company co where co.id = ${task.entityId})
  when ${task.entityType} = 'deal' then (select d.name from deal d where d.id = ${task.entityId})
end`

const SELECT = {
  id: task.id,
  title: task.title,
  body: task.body,
  dueDate: task.dueDate,
  status: task.status,
  assigneeId: task.assigneeId,
  assigneeName: userAccount.name,
  entityType: task.entityType,
  entityId: task.entityId,
  entityName: ENTITY_NAME,
}

export type TaskFilter = {
  status?: 'open' | 'done' | undefined
  assigneeId?: string | undefined
  overdueOnly?: boolean | undefined
  entity?: EntityRef | undefined
}

export const listTasks = async (ctx: WorkspaceContext, filter: TaskFilter = {}): Promise<TaskRow[]> =>
  withWorkspace(ctx, (tx) =>
    tx
      .select(SELECT)
      .from(task)
      .leftJoin(userAccount, eq(userAccount.id, task.assigneeId))
      .where(
        and(
          filter.status ? eq(task.status, filter.status) : undefined,
          filter.assigneeId ? eq(task.assigneeId, filter.assigneeId) : undefined,
          filter.overdueOnly
            ? and(eq(task.status, 'open'), isNotNull(task.dueDate), lt(task.dueDate, sql`current_date`))
            : undefined,
          filter.entity
            ? and(eq(task.entityType, filter.entity.entityType), eq(task.entityId, filter.entity.entityId))
            : undefined,
        ),
      )
      // Undated tasks sit after dated ones rather than jumping to the top. Written
      // as one fragment because asc() would put the direction after the modifier.
      .orderBy(sql`${task.dueDate} asc nulls last`, asc(task.id))
      .limit(500),
  ) as Promise<TaskRow[]>

export type NewTask = {
  title: string
  body?: string | null | undefined
  dueDate?: string | null | undefined
  assigneeId?: string | null | undefined
  entity?: EntityRef | null | undefined
}

export const createTask = async (ctx: WorkspaceContext, input: NewTask): Promise<{ id: string }> =>
  mutate(ctx, 'task', async (tx) => {
    const title = input.title.trim()
    if (!title) throw new Error('A task needs a title.')

    const [row] = await tx
      .insert(task)
      .values({
        workspaceId: ctx.workspaceId,
        title,
        body: input.body ?? null,
        dueDate: input.dueDate ?? null,
        assigneeId: input.assigneeId ?? ctx.actorId,
        entityType: input.entity?.entityType ?? null,
        entityId: input.entity?.entityId ?? null,
        createdBy: ctx.actorId,
      })
      .returning({ id: task.id })
    if (!row) throw new Error('The task could not be created.')

    if (input.entity) {
      await recordActivity(tx, ctx, {
        type: 'task',
        subject: title,
        body: input.body ?? null,
        payload: { taskId: row.id, dueDate: input.dueDate ?? null, status: 'open' },
        links: [input.entity],
      })
    }

    return {
      result: { id: row.id },
      audit: { entity: 'task', entityId: row.id, action: 'create', before: null, after: { title, dueDate: input.dueDate ?? null } },
    }
  })

export const setTaskStatus = async (
  ctx: WorkspaceContext,
  id: string,
  status: 'open' | 'done',
): Promise<void> =>
  mutate(ctx, 'task', async (tx) => {
    const [before] = await tx.select({ status: task.status, title: task.title }).from(task).where(eq(task.id, id))
    if (!before) throw new Error('That task no longer exists.')

    await tx
      .update(task)
      .set({ status, completedAt: status === 'done' ? new Date() : null, updatedAt: new Date() })
      .where(eq(task.id, id))

    // A sequence step that made this task is waiting on it. Completing it here is
    // what moves the outreach on, so nobody has to remember there is a sequence
    // behind the call they just logged.
    if (status === 'done') await onTaskDone(tx, ctx, id)

    return {
      result: undefined,
      audit: { entity: 'task', entityId: id, action: 'status', before: { status: before.status }, after: { status } },
    }
  })

/** The four kinds a person writes by hand. A call that happened is a fact about
 *  the relationship exactly as much as a form submission is, so it lands on the
 *  same rail and answers the same filter rather than living in a notes silo.
 *  Task is absent on purpose: it has a due date and an assignee, so it is a task
 *  row that writes its own activity, not something typed into this box. A3. */
export const LOGGABLE_TYPES = ['note', 'call', 'meeting', 'email'] as const
export type LoggableType = (typeof LOGGABLE_TYPES)[number]

/** A logged activity is a timeline entry, not its own table: it hangs on the same
 *  rail as every other activity and is filtered by the same control. A9.
 *
 *  `occurredAt` is separate from now because a call is logged after it happened,
 *  and the timeline sorts on when it happened. */
export const logByHand = async (
  ctx: WorkspaceContext,
  input: { type: LoggableType; body: string; entity: EntityRef; occurredAt?: Date },
): Promise<{ id: string }> =>
  mutate(ctx, 'activity', async (tx) => {
    const body = input.body.trim()
    if (!body) throw new Error('There is nothing to log.')

    const id = await recordActivity(tx, ctx, {
      type: input.type,
      body,
      occurredAt: input.occurredAt ?? new Date(),
      links: [input.entity],
    })
    if (!id) throw new Error('That could not be attached to the record.')
    if (input.entity.entityType === 'contact') await refreshEmailEngagement(tx, ctx, [input.entity.entityId])

    return {
      result: { id },
      audit: { entity: 'activity', entityId: id, action: input.type, before: null, after: { entity: input.entity } },
    }
  })

/** A hand-logged entry belongs to the person who wrote it. They, or an admin, may
 *  correct or remove it; everything the system wrote stays as it happened. */
const ownLoggedEntry = async (tx: Tx, ctx: WorkspaceContext, id: string) => {
  const [row] = await tx.execute<{ id: string; type: string; body: string | null; actor_id: string | null }>(
    sql`select id, type, body, actor_id from activity where id = ${id} limit 1`,
  )
  if (!row) throw new Error('That entry is no longer on the timeline.')
  if (!(LOGGABLE_TYPES as readonly string[]).includes(row.type)) {
    throw new Error('Only notes, calls, meetings and emails logged by hand can be changed.')
  }
  if (row.actor_id !== ctx.actorId && ctx.role !== 'admin') {
    throw new Error('Only the person who wrote this, or an admin, can change it.')
  }
  return row
}

export const editLoggedEntry = async (ctx: WorkspaceContext, input: { id: string; body: string }): Promise<void> =>
  mutate(ctx, 'activity', async (tx) => {
    const body = input.body.trim()
    if (!body) throw new Error('An entry cannot be emptied. Delete it instead.')
    const before = await ownLoggedEntry(tx, ctx, input.id)
    await tx.execute(sql`update activity set body = ${body} where id = ${input.id}`)
    return {
      result: undefined,
      audit: { entity: 'activity', entityId: input.id, action: 'edit', before: { body: before.body }, after: { body } },
    }
  })

export const deleteLoggedEntry = async (ctx: WorkspaceContext, id: string): Promise<void> =>
  mutate(ctx, 'activity', async (tx) => {
    const before = await ownLoggedEntry(tx, ctx, id)
    const contacts = await tx.execute<{ entity_id: string }>(
      sql`select entity_id from activity_link where activity_id = ${id} and entity_type = 'contact'`,
    )
    // Links cascade. The audit row keeps what was said, so nothing is unrecoverable.
    await tx.execute(sql`delete from activity where id = ${id}`)
    await refreshEmailEngagement(tx, ctx, contacts.map((row) => row.entity_id))
    return {
      result: undefined,
      audit: { entity: 'activity', entityId: id, action: 'delete', before: { type: before.type, body: before.body }, after: null },
    }
  })

export const deleteTask = async (ctx: WorkspaceContext, id: string): Promise<void> =>
  mutate(ctx, 'task', async (tx) => {
    const [row] = await tx.select({ title: task.title }).from(task).where(eq(task.id, id))
    if (!row) throw new Error('That task has already been deleted.')
    await tx.delete(task).where(eq(task.id, id))
    return {
      result: undefined,
      audit: { entity: 'task', entityId: id, action: 'delete', before: row, after: null },
    }
  })

/** The Monday list: deals whose next step date has passed. Not an error state, it
 *  is the signal Trevor chases. A9. */
export const overdueNextSteps = async (ctx: WorkspaceContext): Promise<
  { id: string; name: string | null; nextStep: string | null; nextStepDate: string; ownerName: string | null; stageName: string | null }[]
> =>
  withWorkspace(ctx, (tx) =>
    tx.execute(sql`
      select d.id, d.name, d.next_step as "nextStep", d.next_step_date::text as "nextStepDate",
             u.name as "ownerName", s.name as "stageName"
        from deal d
        left join user_account u on u.id = d.owner_id
        left join pipeline_stage s on s.id = d.stage_id
       where d.deleted_at is null
         and d.next_step_date is not null
         and d.next_step_date < current_date
         and coalesce(s.is_closed_won, false) = false
         and coalesce(s.is_closed_lost, false) = false
       order by d.next_step_date asc
       limit 200`),
  ) as never
