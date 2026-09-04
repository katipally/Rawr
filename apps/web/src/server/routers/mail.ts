import {
  addBlocklistEntry,
  bodyProgress,
  disconnectMailbox,
  listBlocklist,
  listInboxThreads,
  listMailboxes,
  markThreadRead,
  readThread,
  removeBlocklistEntry,
  saveMailbox,
  setMailboxVisibility,
  threadsForContact,
} from '@rawr/db'
import { z } from 'zod'
import { devGmailEnabled } from '~/lib/env.ts'
import { call } from '../errors.ts'
import { hydrateMailboxBodies, syncMailbox } from '../gmail.ts'
import { protectedProcedure, router } from '../trpc.ts'

/** Reading is open to anybody signed in, because a thread on a record is the
 *  record's history. Which threads that means is decided by the mailbox's own
 *  visibility, in SQL, not by what the client asks for; connecting, disconnecting
 *  and sharing are per person, enforced in the data access layer. */
export const mailRouter = router({
  mailboxes: protectedProcedure.query(({ ctx }) => call(() => listMailboxes(ctx.workspace))),

  /** The development mailbox, so the whole path is exercisable before the Google
   *  consent screen exists. Refused outright anywhere it is not enabled, rather
   *  than quietly storing a token that is not one. */
  connectDev: protectedProcedure.mutation(({ ctx }) =>
    call(async () => {
      if (!devGmailEnabled) {
        throw new Error('The development mailbox is not enabled here. Connect a real one with Google.')
      }
      return saveMailbox(ctx.workspace, {
        userId: ctx.session.userId,
        email: ctx.session.email,
        accessToken: 'dev-access',
        refreshToken: 'dev-refresh',
        accessTokenExpiresAt: null,
      })
    }),
  ),

  disconnect: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => disconnectMailbox(ctx.workspace, input.id))),

  /** Who may read what this mailbox brought in. Team by default: continuity is
   *  the point. Private is for a mailbox carrying personal mail. */
  setVisibility: protectedProcedure
    .input(z.object({ mailboxId: z.uuid(), visibility: z.enum(['team', 'private']) }))
    .mutation(({ ctx, input }) => call(() => setMailboxVisibility(ctx.workspace, input))),

  /** How much of the back-fill has had its body stored, so a long run is visible
   *  rather than mysterious. */
  bodyProgress: protectedProcedure.query(({ ctx }) => call(() => bodyProgress(ctx.workspace))),

  /** One hydrate pass by hand, the way `sync` is. The worker runs the same
   *  function on a schedule. */
  hydrate: protectedProcedure
    .input(z.object({ id: z.uuid(), limit: z.number().int().min(1).max(200).optional() }))
    .mutation(({ ctx, input }) => call(() => hydrateMailboxBodies(ctx.workspace, input.id, input.limit ?? 50))),

  /** One pass, run by hand. The worker runs the same function on a schedule; this
   *  is for somebody who has just connected and wants to see history appear. */
  sync: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      call(() => syncMailbox(ctx.workspace, input.id)),
    ),

  blocklist: router({
    list: protectedProcedure.query(({ ctx }) => call(() => listBlocklist(ctx.workspace))),

    add: protectedProcedure
      .input(
        z.object({
          pattern: z.string().trim().min(3).max(200),
          note: z.string().max(200).nullish(),
          scope: z.enum(['workspace', 'mine']),
        }),
      )
      .mutation(({ ctx, input }) =>
        call(() =>
          addBlocklistEntry(ctx.workspace, {
            pattern: input.pattern,
            ...(input.note !== undefined ? { note: input.note } : {}),
            scope: input.scope,
          }),
        ),
      ),

    remove: protectedProcedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => call(() => removeBlocklistEntry(ctx.workspace, input.id))),
  }),

  threadsFor: protectedProcedure
    .input(z.object({ contactId: z.uuid(), limit: z.number().int().min(1).max(100).optional() }))
    .query(({ ctx, input }) =>
      call(() => threadsForContact(ctx.workspace, input.contactId, input.limit ?? 20)),
    ),

  thread: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => call(() => readThread(ctx.workspace, input.id))),

  /** The shared inbox. Keyset paged; the filters are all on the thread, so page
   *  fifty costs what page one costs. */
  inbox: protectedProcedure
    .input(
      z
        .object({
          scope: z.enum(['mine', 'all']).optional(),
          mailboxId: z.uuid().nullable().optional(),
          unreplied: z.boolean().optional(),
          unread: z.boolean().optional(),
          q: z.string().trim().max(200).nullable().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          cursor: z.object({ lastAt: z.string(), id: z.uuid() }).nullable().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => call(() => listInboxThreads(ctx.workspace, input ?? {}))),

  /** Marks a thread read up to now, for the caller alone. A separate call, so a
   *  background refresh cannot silently clear somebody's unread count. */
  markRead: protectedProcedure
    .input(z.object({ threadId: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => markThreadRead(ctx.workspace, input.threadId))),
})
