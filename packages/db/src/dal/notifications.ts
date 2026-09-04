import { sql } from 'drizzle-orm'
import type { WorkspaceContext } from './context.ts'
import { withWorkspace } from './index.ts'

/** What the bell in the top bar has to say. One query rather than five, because
 *  it runs on every page and nothing here is worth a round trip of its own.
 *
 *  Two audiences in one shape: everybody sees their own overdue work, an admin
 *  also sees what is broken. The role is read from the context rather than
 *  passed, so a caller cannot ask for somebody else's list. */

export type NotificationSummary = {
  myOverdueTasks: number
  quarantined: number
  /** Admin only; zero for everybody else, which is what keeps the bell quiet. */
  deadLetters: number
  brokenIntegrations: number
  brokenMailboxes: number
  total: number
}

export const readNotifications = async (ctx: WorkspaceContext): Promise<NotificationSummary> =>
  withWorkspace(ctx, async (tx) => {
    const admin = ctx.role === 'admin'
    const [row] = await tx.execute<{
        my_overdue: number
        quarantined: number
        dead_letters: number
        broken_integrations: number
      broken_mailboxes: number
    }>(sql`
        select
          (select count(*) from task
            where status = 'open' and assignee_id = ${ctx.actorId}::uuid
              and due_date is not null and due_date < current_date)::int as my_overdue,
          (select count(*) from form_submission where spam_state = 'quarantined')::int as quarantined,
          ${admin ? sql`(select count(*) from dead_letter where replayed_at is null)::int` : sql`0`} as dead_letters,
          ${admin ? sql`(select count(*) from integration where last_error is not null and state <> 'unconfigured')::int` : sql`0`} as broken_integrations,
          ${admin ? sql`(select count(*) from mailbox where state = 'revoked' or last_error is not null)::int` : sql`0`} as broken_mailboxes
    `)

    const counts = {
      myOverdueTasks: Number(row?.my_overdue ?? 0),
      quarantined: Number(row?.quarantined ?? 0),
      deadLetters: Number(row?.dead_letters ?? 0),
      brokenIntegrations: Number(row?.broken_integrations ?? 0),
      brokenMailboxes: Number(row?.broken_mailboxes ?? 0),
    }
    return {
      ...counts,
      total:
        counts.myOverdueTasks +
        counts.quarantined +
        counts.deadLetters +
        counts.brokenIntegrations +
        counts.brokenMailboxes,
    }
  })
