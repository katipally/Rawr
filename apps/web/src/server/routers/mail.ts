import {
  addBlocklistEntry,
  disconnectMailbox,
  listBlocklist,
  listMailboxes,
  readThread,
  removeBlocklistEntry,
  saveMailbox,
  threadsForContact,
} from '@rawr/db'
import { z } from 'zod'
import { devGmailEnabled } from '~/lib/env.ts'
import { call } from '../errors.ts'
import { syncMailbox } from '../gmail.ts'
import { protectedProcedure, router } from '../trpc.ts'

/** F1 phase B. Reading is open to anybody signed in, because a thread on a record
 *  is the record's history; connecting and disconnecting is per person, enforced
 *  in the data access layer. */
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
})
