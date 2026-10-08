import { and, eq, ne, sql } from 'drizzle-orm'
import { membership } from '../schema/identity.ts'
import { mailbox, message, messageThread, messageThreadRead } from '../schema/messaging.ts'
import { isAdmin, type AccountContext } from './context.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import type { MailboxState } from './messages.ts'

/** Inbox folders and the Gmail changes that follow them. Rawr records a change at
 *  once; the worker pushes it to Gmail. A Gmail-side change is read back only when
 *  nothing is waiting here, so a pass that read Gmail earlier cannot undo a change
 *  Rawr made after it. */

export type FolderState = { archived: boolean; trashed: boolean }

/** What Gmail says about a thread, read from the labels on its messages: in Trash if
 *  any message is, in the Inbox if any message is. */
export const labelsOfThread = (labelsPerMessage: string[][]): { trashed: boolean; inInbox: boolean } => ({
  trashed: labelsPerMessage.some((labels) => labels.includes('TRASH')),
  inInbox: labelsPerMessage.some((labels) => labels.includes('INBOX')),
})

/** Trash wins. A thread with no message left in the Inbox is archived. */
export const threadStateFromLabels = (labelsPerMessage: string[][]): FolderState => {
  const { trashed, inInbox } = labelsOfThread(labelsPerMessage)
  return { archived: !trashed && !inInbox, trashed }
}

/** The labels a thread should carry in Gmail for this state. Trash is not in the Inbox. */
export const gmailLabelsFor = ({ archived, trashed }: FolderState): { trashed: boolean; inbox: boolean } => ({
  trashed,
  inbox: !archived && !trashed,
})

/** The Gmail calls that bring a thread from what Gmail has to what Rawr wants. Only the
 *  differences are sent, so a push that repeats is a no-op. */
export const folderChanges = (
  inGmail: { trashed: boolean; inInbox: boolean },
  want: { trashed: boolean; inbox: boolean },
): { trash: boolean; untrash: boolean; addInbox: boolean; removeInbox: boolean } => ({
  trash: want.trashed && !inGmail.trashed,
  untrash: !want.trashed && inGmail.trashed,
  addInbox: want.inbox && !inGmail.inInbox,
  removeInbox: !want.inbox && inGmail.inInbox,
})

export type ThreadChange =
  | { kind: 'archived'; value: boolean }
  | { kind: 'trashed'; value: boolean }
  | { kind: 'assignee'; value: string | null }
  | { kind: 'unread'; value: boolean }

/** A thread the actor may read: at least one of its messages is in a mailbox they
 *  may see, or in none. The same rule readThread applies. */
const assertVisible = async (tx: Tx, ctx: AccountContext, threadId: string): Promise<void> => {
  const [seen] = await tx.execute<{ id: string }>(sql`
    select t.id from message_thread t
     where t.id = ${threadId}::uuid
       and exists (select 1 from message m left join mailbox mb on mb.id = m.mailbox_id
                    where m.thread_id = t.id
                      and (m.mailbox_id is null or mb.visibility = 'team'
                           or mb.user_id = ${ctx.actorId ?? null}::uuid or ${isAdmin(ctx)}))
     limit 1`)
  if (!seen) throw new Error('That conversation is not here.')
}

/** Unread is the person's own read row set back to before the thread's last message.
 *  The epoch is a sentinel, not a date anybody reads. */
const UNREAD_SENTINEL = new Date(0)

export const changeThread = async (ctx: AccountContext, threadId: string, change: ThreadChange): Promise<void> => {
  if (change.kind === 'unread') {
    if (!ctx.actorId) throw new Error('Only a person can mark a conversation read or unread.')
    await mutate(ctx, 'message_thread_read', async (tx) => {
      await assertVisible(tx, ctx, threadId)
      const now = new Date()
      await tx
        .insert(messageThreadRead)
        .values({
          accountId: ctx.accountId,
          threadId,
          userId: ctx.actorId as string,
          lastReadAt: change.value ? UNREAD_SENTINEL : now,
          gmailUnread: change.value,
        })
        .onConflictDoUpdate({
          target: [messageThreadRead.accountId, messageThreadRead.threadId, messageThreadRead.userId],
          set: { lastReadAt: change.value ? UNREAD_SENTINEL : now, gmailUnread: change.value },
        })
      return {
        result: undefined,
        audit: { entity: 'message_thread_read', entityId: threadId, action: change.value ? 'unread' : 'read', before: null, after: null },
      }
    })
    return
  }

  await mutate(ctx, 'message_thread', async (tx) => {
    await assertVisible(tx, ctx, threadId)
    const [before] = await tx
      .select({ archivedAt: messageThread.archivedAt, trashedAt: messageThread.trashedAt, assignedTo: messageThread.assignedTo })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1)
    if (!before) throw new Error('That conversation is not here.')
    const now = new Date()

    if (change.kind === 'archived' || change.kind === 'trashed') {
      const at = change.value ? now : null
      await tx
        .update(messageThread)
        .set(change.kind === 'archived' ? { archivedAt: at, stateChangedAt: now } : { trashedAt: at, stateChangedAt: now })
        .where(eq(messageThread.id, threadId))
      return {
        result: undefined,
        audit: {
          entity: 'message_thread',
          entityId: threadId,
          action: change.kind === 'archived' ? (change.value ? 'archive' : 'unarchive') : change.value ? 'trash' : 'restore',
          before: null,
          after: null,
        },
      }
    }

    if (change.value !== null) {
      const [member] = await tx
        .select({ userId: membership.userId })
        .from(membership)
        .where(and(eq(membership.userId, change.value), ne(membership.state, 'deactivated')))
        .limit(1)
      if (!member) throw new Error('That person has left this account, so they cannot be assigned a conversation.')
    }
    await tx.update(messageThread).set({ assignedTo: change.value }).where(eq(messageThread.id, threadId))
    return {
      result: undefined,
      audit: {
        entity: 'message_thread',
        entityId: threadId,
        action: change.value ? 'assign' : 'unassign',
        before: { assignedTo: before.assignedTo },
        after: { assignedTo: change.value },
      },
    }
  })
}

/** Gmail said what the folders are. Applied only when nothing is waiting, and only
 *  when Gmail was read after the last Rawr change, so a stale read cannot win. */
export const reconcileThreadFolders = async (
  ctx: AccountContext,
  providerThreadId: string,
  state: FolderState,
  readAt: Date,
): Promise<void> => {
  const at = readAt.toISOString()
  await withAccount(ctx, (tx) =>
    tx.execute(sql`
      update message_thread
         set archived_at = case when ${state.archived} then coalesce(archived_at, ${at}::timestamptz) else null end,
             trashed_at = case when ${state.trashed} then coalesce(trashed_at, ${at}::timestamptz) else null end
       where provider_thread_id = ${providerThreadId}
         and (state_changed_at is null
              or (gmail_synced_at = state_changed_at and state_changed_at < ${at}::timestamptz))`),
  )
}

export type ThreadPush = {
  providerThreadId: string
  archived: boolean
  trashed: boolean
  /** The change this push is for. Acknowledged only if it is still the latest. */
  version: Date | null
  mailboxes: { id: string; userId: string; state: MailboxState; canModify: boolean }[]
  unread: { userId: string; wanted: boolean }[]
}

/** Everything one push needs, read in one place. Not limited to what the actor may
 *  see: the worker acts for the account, on the mailboxes that hold the thread. */
export const threadPushPlan = async (ctx: AccountContext, threadId: string): Promise<ThreadPush | null> =>
  withAccount(ctx, async (tx) => {
    const [thread] = await tx
      .select({
        providerThreadId: messageThread.providerThreadId,
        archivedAt: messageThread.archivedAt,
        trashedAt: messageThread.trashedAt,
        stateChangedAt: messageThread.stateChangedAt,
      })
      .from(messageThread)
      .where(eq(messageThread.id, threadId))
      .limit(1)
    if (!thread) return null

    const mailboxes = await tx
      .selectDistinct({ id: mailbox.id, userId: mailbox.userId, state: mailbox.state, canModify: mailbox.canModify })
      .from(message)
      .innerJoin(mailbox, eq(mailbox.id, message.mailboxId))
      .where(eq(message.threadId, threadId))

    const unread = await tx
      .select({ userId: messageThreadRead.userId, wanted: messageThreadRead.gmailUnread })
      .from(messageThreadRead)
      .where(and(eq(messageThreadRead.threadId, threadId), sql`${messageThreadRead.gmailUnread} is not null`))

    return {
      providerThreadId: thread.providerThreadId,
      archived: thread.archivedAt !== null,
      trashed: thread.trashedAt !== null,
      version: thread.stateChangedAt,
      mailboxes,
      unread: unread.map((row) => ({ userId: row.userId, wanted: row.wanted === true })),
    }
  })

/** Forgets a pending change once Gmail has it. Does nothing if a newer change was
 *  made while the push ran: that one is still waiting. */
export const acknowledgeThreadPush = async (ctx: AccountContext, threadId: string, version: Date): Promise<void> => {
  await withAccount(ctx, (tx) =>
    tx
      .update(messageThread)
      .set({ gmailSyncedAt: sql`${messageThread.stateChangedAt}` })
      .where(and(eq(messageThread.id, threadId), eq(messageThread.stateChangedAt, version))),
  )
}

export const acknowledgeUnreadPush = async (ctx: AccountContext, threadId: string, userId: string, wanted: boolean): Promise<void> => {
  await withAccount(ctx, (tx) =>
    tx
      .update(messageThreadRead)
      .set({ gmailUnread: null })
      .where(
        and(
          eq(messageThreadRead.threadId, threadId),
          eq(messageThreadRead.userId, userId),
          eq(messageThreadRead.gmailUnread, wanted),
        ),
      ),
  )
}

/** A mailbox connected with gmail.modify again has missed every change Rawr made while it
 *  could not push. Every thread it holds that Rawr has ever changed is queued again, so
 *  the next push sets Gmail to what Rawr says. */
export const requeueThreadsOfMailbox = async (tx: Tx, mailboxId: string, at: Date): Promise<void> => {
  await tx.execute(sql`
    update message_thread
       set state_changed_at = ${at.toISOString()}::timestamptz
     where state_changed_at is not null
       and id in (select thread_id from message where mailbox_id = ${mailboxId}::uuid)`)
}
