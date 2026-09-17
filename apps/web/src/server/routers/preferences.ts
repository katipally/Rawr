import { getPrefs, setPref } from '@rawr/db'
import { z } from 'zod'
import { call } from '../errors.ts'
import { protectedProcedure, router } from '../trpc.ts'

/** What used to live only in localStorage. `protectedProcedure`, not
 *  `adminProcedure`: a preference is addressed to a person, and `ctx.account`
 *  carries their account and their own id from the session, the same way
 *  `notificationsRouter` does. Nothing here takes a user id from its input. */

/** Well under Postgres's own jsonb limit, generous for a bookmarks list or a
 *  timeline filter, and small enough that a corrupted or hostile payload cannot
 *  turn one write into a large row. */
const MAX_VALUE_BYTES = 64 * 1024

export const preferencesRouter = router({
  all: protectedProcedure.query(({ ctx }) => call(() => getPrefs(ctx.account))),

  set: protectedProcedure
    .input(
      z.object({
        key: z.string().min(1).max(200),
        value: z.unknown().refine(
          (value) => JSON.stringify(value ?? null).length <= MAX_VALUE_BYTES,
          `A preference value must be under ${MAX_VALUE_BYTES} bytes.`,
        ),
      }),
    )
    .mutation(({ ctx, input }) => call(() => setPref(ctx.account, input.key, input.value ?? null))),
})
