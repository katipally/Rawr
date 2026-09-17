import { and, eq } from 'drizzle-orm'
import { preference } from '../schema/preferences.ts'
import type { AccountContext } from './context.ts'
import { withAccount } from './index.ts'

/** Everything a person set that has to follow them to another machine: bookmarks,
 *  recent navigation, a timeline filter, a collapsed panel, the rail's width.
 *
 *  Scoped on `ctx.actorId` throughout, the same way `notifications.ts` scopes the
 *  bell: no function here takes a user id from its caller, so reading or writing
 *  somebody else's preferences is not a thing the shape allows. */

export type Preferences = Record<string, unknown>

/** One query, not one per key: the row set for this account and person is small
 *  and the unique index is exactly this lookup's shape, so this is an index scan
 *  returning however many keys exist, O(k) in the number of preferences set. */
export const getPrefs = async (ctx: AccountContext): Promise<Preferences> =>
  withAccount(ctx, async (tx) => {
    if (!ctx.actorId) return {}
    const rows = await tx
      .select({ key: preference.key, value: preference.value })
      .from(preference)
      .where(and(eq(preference.accountId, ctx.accountId), eq(preference.userId, ctx.actorId)))
    return Object.fromEntries(rows.map((row) => [row.key, row.value]))
  })

export const setPref = async (ctx: AccountContext, key: string, value: unknown): Promise<void> => {
  if (!ctx.actorId) return
  await withAccount(ctx, (tx) =>
    tx
      .insert(preference)
      .values({ accountId: ctx.accountId, userId: ctx.actorId!, key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [preference.accountId, preference.userId, preference.key],
        set: { value, updatedAt: new Date() },
      }),
  )
}
