import { and, asc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { task, taskQueue, type TaskPriority, type TaskType } from '../schema/records.ts'
import { userAccount } from '../schema/identity.ts'
import { linksForContacts, recordActivity, type EntityRef } from './activity.ts'
import { isAdmin, type AccountContext } from './context.ts'
import { refreshEmailEngagement } from './engagement.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import { notify, resolveNotifications } from './notifications.ts'
import { entityAlive } from './registry.ts'
// A sequence step can make a task, and completing that task resumes the sequence.
// The two modules import each other for exactly that pair of calls; Node resolves
// the cycle because neither reads the other at module scope.
import { onTaskDone } from './sequences.ts'

export type TaskRow = {
  id: string
  title: string
  body: string | null
  type: TaskType
  priority: TaskPriority
  dueDate: string | null
  remindAt: Date | null
  queueId: string | null
  queueName: string | null
  status: 'open' | 'done'
  assigneeName: string | null
  assigneeId: string | null
  /** An object key, core or invented. Null for a task that hangs on nothing. */
  entityType: string | null
  entityId: string | null
  entityName: string | null
}

const ENTITY_NAME = sql<string | null>`case
  when ${task.entityType} = 'contact' then (select coalesce(nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), ''), c.email) from contact c where c.id = ${task.entityId})
  when ${task.entityType} = 'company' then (select coalesce(co.name, co.domain) from company co where co.id = ${task.entityId})
  when ${task.entityType} = 'deal' then (select d.name from deal d where d.id = ${task.entityId})
  -- An object an admin invented. Its name is whichever field it nominated, in
  -- the blob, so the key has to be read from the registry tables rather than
  -- written into this expression.
  else (select nullif(trim(r.custom ->> f.key), '')
          from custom_record r
          join object_def o on o.id = r.object_id
          join field_def f on f.id = o.label_field_id
         where r.id = ${task.entityId} and o.key = ${task.entityType})
end`

const SELECT = {
  id: task.id,
  title: task.title,
  body: task.body,
  type: task.type,
  priority: task.priority,
  dueDate: task.dueDate,
  remindAt: task.remindAt,
  queueId: task.queueId,
  queueName: taskQueue.name,
  status: task.status,
  assigneeId: task.assigneeId,
  assigneeName: userAccount.name,
  entityType: sql<string | null>`case when ${entityAlive(task.entityType, task.entityId)} then ${task.entityType} end`,
  entityId: sql<string | null>`case when ${entityAlive(task.entityType, task.entityId)} then ${task.entityId} end`,
  entityName: ENTITY_NAME,
}

export type TaskFilter = {
  status?: 'open' | 'done' | undefined
  assigneeId?: string | undefined
  overdueOnly?: boolean | undefined
  /** Open tasks due today, or open tasks due after today. */
  due?: 'today' | 'upcoming' | undefined
  entity?: EntityRef | undefined
  type?: TaskType | undefined
  /** A queue id, or 'none' for the tasks that are in no queue. */
  queueId?: string | 'none' | undefined
}

/** The most rows one view of the list reads. The page renders in slices of its
 *  own and searches in the browser over everything it was given, so this is the
 *  point past which the view stops being the whole truth and has to say so. */
export const TASK_LIST_CAP = 500

export const listTasks = async (ctx: AccountContext, filter: TaskFilter = {}): Promise<TaskRow[]> =>
  withAccount(ctx, (tx) =>
    tx
      .select(SELECT)
      .from(task)
      .leftJoin(userAccount, eq(userAccount.id, task.assigneeId))
      .leftJoin(taskQueue, eq(taskQueue.id, task.queueId))
      .where(
        and(
          filter.status ? eq(task.status, filter.status) : undefined,
          filter.assigneeId ? eq(task.assigneeId, filter.assigneeId) : undefined,
          filter.type ? eq(task.type, filter.type) : undefined,
          filter.queueId === 'none'
            ? isNull(task.queueId)
            : filter.queueId
              ? eq(task.queueId, filter.queueId)
              : undefined,
          filter.overdueOnly
            ? and(eq(task.status, 'open'), isNotNull(task.dueDate), lt(task.dueDate, sql`current_date`))
            : undefined,
          filter.due === 'today' ? and(eq(task.status, 'open'), eq(task.dueDate, sql`current_date`)) : undefined,
          filter.due === 'upcoming' ? and(eq(task.status, 'open'), gt(task.dueDate, sql`current_date`)) : undefined,
          filter.entity
            ? and(eq(task.entityType, filter.entity.entityType), eq(task.entityId, filter.entity.entityId))
            : undefined,
        ),
      )
      // Undated tasks sit after dated ones rather than jumping to the top. Written
      // as one fragment because asc() would put the direction after the modifier.
      .orderBy(sql`${task.dueDate} asc nulls last`, asc(task.id))
      .limit(TASK_LIST_CAP),
  ) as Promise<TaskRow[]>

export type NewTask = {
  title: string
  body?: string | null | undefined
  type?: TaskType | undefined
  priority?: TaskPriority | undefined
  dueDate?: string | null | undefined
  remindAt?: Date | null | undefined
  queueId?: string | null | undefined
  assigneeId?: string | null | undefined
  entity?: EntityRef | null | undefined
}

/** Handing work to somebody is not done until they know. Silent when the task is
 *  your own, and `notify` drops the actor anyway, so this stays true even if a
 *  caller passes its own id explicitly. */
const tellAssignee = async (
  tx: Tx,
  ctx: AccountContext,
  input: { id: string; title: string; assigneeId: string | null; dueDate: string | null },
): Promise<void> => {
  if (!input.assigneeId || input.assigneeId === ctx.actorId) return
  await notify(tx, ctx, {
    kind: 'task_assigned',
    dedupeKey: `task:assigned:${input.id}:${input.assigneeId}`,
    title: `${input.title} was assigned to you`,
    body: input.dueDate ? `Due ${input.dueDate}.` : 'No due date.',
    entity: 'task',
    entityId: input.id,
    to: { userIds: [input.assigneeId] },
  })
}

export const createTask = async (ctx: AccountContext, input: NewTask): Promise<{ id: string }> =>
  mutate(ctx, 'task', async (tx) => {
    const title = input.title.trim()
    if (!title) throw new Error('A task needs a title.')

    const assigneeId = input.assigneeId ?? ctx.actorId
    const [row] = await tx
      .insert(task)
      .values({
        accountId: ctx.accountId,
        title,
        body: input.body ?? null,
        type: input.type ?? 'todo',
        priority: input.priority ?? 'medium',
        dueDate: input.dueDate ?? null,
        remindAt: input.remindAt ?? null,
        queueId: input.queueId ?? null,
        assigneeId,
        entityType: input.entity?.entityType ?? null,
        entityId: input.entity?.entityId ?? null,
        createdBy: ctx.actorId,
      })
      .returning({ id: task.id })
    if (!row) throw new Error('The task could not be created.')

    await tellAssignee(tx, ctx, { id: row.id, title, assigneeId, dueDate: input.dueDate ?? null })

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

/** Every field a person can change after the fact, including who it belongs to.
 *  An absent key is left alone; an explicit null clears the column, which is how
 *  "no queue" and "no reminder" are said. */
export type TaskEdit = {
  id: string
  title?: string | undefined
  body?: string | null | undefined
  type?: TaskType | undefined
  priority?: TaskPriority | undefined
  dueDate?: string | null | undefined
  remindAt?: Date | null | undefined
  queueId?: string | null | undefined
  assigneeId?: string | null | undefined
}

export const updateTask = async (ctx: AccountContext, input: TaskEdit): Promise<void> =>
  mutate(ctx, 'task', async (tx) => {
    const [before] = await tx
      .select({ title: task.title, assigneeId: task.assigneeId, dueDate: task.dueDate, queueId: task.queueId })
      .from(task)
      .where(eq(task.id, input.id))
    if (!before) throw new Error('That task no longer exists.')

    const title = input.title === undefined ? before.title : input.title.trim()
    if (!title) throw new Error('A task needs a title.')

    const values = {
      title,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.type === undefined ? {} : { type: input.type }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
      ...(input.remindAt === undefined ? {} : { remindAt: input.remindAt }),
      ...(input.queueId === undefined ? {} : { queueId: input.queueId }),
      ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
      updatedAt: new Date(),
    }
    await tx.update(task).set(values).where(eq(task.id, input.id))

    const assigneeId = input.assigneeId === undefined ? before.assigneeId : input.assigneeId
    if (assigneeId !== before.assigneeId) {
      const dueDate = input.dueDate === undefined ? before.dueDate : input.dueDate
      await tellAssignee(tx, ctx, { id: input.id, title, assigneeId, dueDate })
    }

    return {
      result: undefined,
      audit: {
        entity: 'task',
        entityId: input.id,
        action: 'update',
        before: { title: before.title, assigneeId: before.assigneeId, queueId: before.queueId },
        after: { title, assigneeId, queueId: input.queueId === undefined ? before.queueId : input.queueId },
      },
    }
  })

export type TaskQueueRow = { id: string; name: string; openCount: number }

/** Bounded because the sidebar renders every one of them. A hundred named lists
 *  is already past the point where anybody finds theirs by reading. */
const MAX_QUEUES = 200

export const listTaskQueues = async (ctx: AccountContext): Promise<TaskQueueRow[]> =>
  withAccount(ctx, (tx) =>
    tx.execute(sql`
      select q.id, q.name,
             (select count(*)::int from task t
               where t.queue_id = q.id and t.status = 'open') as "openCount"
        from task_queue q
       order by lower(q.name)
       limit ${MAX_QUEUES}`),
  ) as Promise<TaskQueueRow[]>

export const createTaskQueue = async (ctx: AccountContext, name: string): Promise<{ id: string }> =>
  mutate(ctx, 'task', async (tx) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('A queue needs a name.')

    // The unique index is on lower(name), so letting it decide is both the check
    // and the race, in one statement.
    const [row] = await tx
      .insert(taskQueue)
      .values({ accountId: ctx.accountId, name: trimmed, createdBy: ctx.actorId })
      .onConflictDoNothing()
      .returning({ id: taskQueue.id })
    if (!row) throw new Error(`There is already a queue called “${trimmed}”.`)

    return {
      result: { id: row.id },
      audit: { entity: 'task_queue', entityId: row.id, action: 'create', before: null, after: { name: trimmed } },
    }
  })

export const renameTaskQueue = async (ctx: AccountContext, id: string, name: string): Promise<void> =>
  mutate(ctx, 'task', async (tx) => {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('A queue needs a name.')

    const [before] = await tx.select({ name: taskQueue.name }).from(taskQueue).where(eq(taskQueue.id, id))
    if (!before) throw new Error('That queue no longer exists.')

    const clash = await tx.execute<{ id: string }>(
      sql`select id from task_queue where lower(name) = lower(${trimmed}) and id <> ${id} limit 1`,
    )
    if (clash.length > 0) throw new Error(`There is already a queue called “${trimmed}”.`)

    await tx.update(taskQueue).set({ name: trimmed, updatedAt: new Date() }).where(eq(taskQueue.id, id))

    return {
      result: undefined,
      audit: { entity: 'task_queue', entityId: id, action: 'rename', before, after: { name: trimmed } },
    }
  })

/** The tasks in it are returned to no queue by the foreign key, not deleted.
 *  Somebody tidying their lists must never lose work by doing it. */
export const deleteTaskQueue = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'task', async (tx) => {
    const [before] = await tx.select({ name: taskQueue.name }).from(taskQueue).where(eq(taskQueue.id, id))
    if (!before) throw new Error('That queue has already been deleted.')
    await tx.delete(taskQueue).where(eq(taskQueue.id, id))
    return {
      result: undefined,
      audit: { entity: 'task_queue', entityId: id, action: 'delete', before, after: null },
    }
  })

export const setTaskStatus = async (
  ctx: AccountContext,
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
    if (status === 'done') {
      await onTaskDone(tx, ctx, id)
      // The three notices this task can have raised stop being true the moment it
      // is done, and a stored notice cannot work that out for itself. Each sweep
      // adds the due date or the reminder time after the id, so the id is the
      // prefix that catches every one of them.
      for (const kind of ['overdue', 'remind', 'assigned']) {
        await resolveNotifications(tx, ctx, `task:${kind}:${id}`)
      }
    }

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
  ctx: AccountContext,
  input: { type: LoggableType; body: string; entity: EntityRef; occurredAt?: Date },
): Promise<{ id: string }> =>
  mutate(ctx, 'activity', async (tx) => {
    const body = input.body.trim()
    if (!body) throw new Error('There is nothing to log.')

    const id = await recordActivity(tx, ctx, {
      type: input.type,
      body,
      occurredAt: input.occurredAt ?? new Date(),
      // A call with a contact is a call with their company, the same way a synced
      // email is. Logged on anything else, it hangs on that one record.
      links:
        input.entity.entityType === 'contact'
          ? await linksForContacts(tx, [input.entity.entityId])
          : [input.entity],
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
const ownLoggedEntry = async (tx: Tx, ctx: AccountContext, id: string) => {
  const [row] = await tx.execute<{ id: string; type: string; body: string | null; actor_id: string | null; synced: boolean }>(
    sql`select id, type, body, actor_id, (payload ? 'threadId') as synced from activity where id = ${id} limit 1`,
  )
  if (!row) throw new Error('That entry is no longer on the timeline.')
  // An email with a thread behind it was read from a mailbox or sent by a
  // sequence: a record of what went over the wire, not something anybody typed.
  if (!(LOGGABLE_TYPES as readonly string[]).includes(row.type) || row.synced) {
    throw new Error('Only notes, calls, meetings and emails logged by hand can be changed.')
  }
  if (row.actor_id !== ctx.actorId && !isAdmin(ctx)) {
    throw new Error('Only the person who wrote this, or an admin, can change it.')
  }
  return row
}

export const editLoggedEntry = async (ctx: AccountContext, input: { id: string; body: string }): Promise<void> =>
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

export const deleteLoggedEntry = async (ctx: AccountContext, id: string): Promise<void> =>
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

export const deleteTask = async (ctx: AccountContext, id: string): Promise<void> =>
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
export const overdueNextSteps = async (ctx: AccountContext): Promise<
  { id: string; name: string | null; nextStep: string | null; nextStepDate: string; ownerName: string | null; stageName: string | null }[]
> =>
  withAccount(ctx, (tx) =>
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
