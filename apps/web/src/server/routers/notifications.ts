import {
  listNotifications,
  markAllRead,
  markRead,
  restoreNotification,
  trashNotification,
  unreadCount,
} from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { protectedProcedure, router } from '../trpc.ts'

/** The drawer's whole surface.
 *
 *  `protectedProcedure`, not `adminProcedure`: a notification is addressed to a
 *  person, and the row's own `user_id` is the gate. Nothing here takes a user id
 *  from its input, which is the same rule `session.signOutEverywhere` states. */
export const notificationsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        tab: z.enum(['unread', 'all', 'trash']).default('unread'),
        cursor: z.object({ at: z.string().max(64), id: z.uuid() }).nullish(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
    )
    .query(({ ctx, input }) =>
      call(() =>
        listNotifications(ctx.account, {
          tab: input.tab,
          cursor: input.cursor ?? null,
          limit: input.limit,
        }),
      ),
    ),

  unreadCount: protectedProcedure.query(({ ctx }) => call(() => unreadCount(ctx.account))),

  markRead: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => markRead(ctx.account, input.id))),

  markAllRead: protectedProcedure.mutation(({ ctx }) => call(() => markAllRead(ctx.account))),

  trash: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => trashNotification(ctx.account, input.id))),

  restore: protectedProcedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => call(() => restoreNotification(ctx.account, input.id))),
})
