import { asc, eq, sql } from 'drizzle-orm'
import { subscriptionState, subscriptionType } from '../schema/marketing.ts'
import { recordActivity } from './activity.ts'
import type { WorkspaceContext } from './context.ts'
import { mutate, withWorkspace } from './index.ts'

export type SubscriptionState = 'subscribed' | 'unsubscribed' | 'unspecified'

export type SubscriptionRow = {
  typeId: string
  name: string
  description: string | null
  isInternal: boolean
  state: SubscriptionState
  changedAt: Date | null
}

/** Three states, and 'unspecified' is one of them. A contact who has never said
 *  anything must render as exactly that, never as subscribed, never as
 *  unsubscribed, never as blank. D15, A2. */
export const readSubscriptions = async (
  ctx: WorkspaceContext,
  contactId: string,
): Promise<SubscriptionRow[]> =>
  withWorkspace(ctx, (tx) =>
    tx
      .select({
        typeId: subscriptionType.id,
        name: subscriptionType.name,
        description: subscriptionType.description,
        isInternal: subscriptionType.isInternal,
        state: sql<SubscriptionState>`coalesce(${subscriptionState.state}, 'unspecified')`,
        changedAt: subscriptionState.changedAt,
      })
      .from(subscriptionType)
      .leftJoin(
        subscriptionState,
        sql`${subscriptionState.subscriptionTypeId} = ${subscriptionType.id} and ${subscriptionState.contactId} = ${contactId}`,
      )
      .orderBy(asc(subscriptionType.name)),
  )

export const sentenceFor = (contactName: string, rows: SubscriptionRow[]): string | null =>
  rows.every((row) => row.state === 'unspecified')
    ? `${contactName} has not specified any preferences.`
    : null

/** An opt-out recorded in Rawr is the authoritative one. F6 pushes it outward and
 *  never the reverse for a Rawr-originated opt-out. A2. */
export const setSubscription = async (
  ctx: WorkspaceContext,
  input: { contactId: string; typeId: string; state: SubscriptionState; source?: string },
): Promise<void> =>
  mutate(ctx, 'subscription_state', async (tx) => {
    const [type] = await tx
      .select({ name: subscriptionType.name })
      .from(subscriptionType)
      .where(eq(subscriptionType.id, input.typeId))
    if (!type) throw new Error('That subscription type no longer exists.')

    const [before] = await tx
      .select({ state: subscriptionState.state })
      .from(subscriptionState)
      .where(
        sql`${subscriptionState.contactId} = ${input.contactId} and ${subscriptionState.subscriptionTypeId} = ${input.typeId}`,
      )

    await tx
      .insert(subscriptionState)
      .values({
        workspaceId: ctx.workspaceId,
        contactId: input.contactId,
        subscriptionTypeId: input.typeId,
        state: input.state,
        source: input.source ?? 'app',
      })
      .onConflictDoUpdate({
        target: [subscriptionState.workspaceId, subscriptionState.contactId, subscriptionState.subscriptionTypeId],
        set: { state: input.state, changedAt: new Date(), source: input.source ?? 'app' },
      })

    await recordActivity(tx, ctx, {
      type: 'subscription_change',
      subject: `${type.name}: ${input.state}`,
      payload: { typeId: input.typeId, from: before?.state ?? 'unspecified', to: input.state },
      links: [{ entityType: 'contact', entityId: input.contactId }],
    })

    return {
      result: undefined,
      audit: {
        entity: 'subscription_state',
        entityId: input.contactId,
        action: 'set',
        before: { state: before?.state ?? 'unspecified', typeId: input.typeId },
        after: { state: input.state, typeId: input.typeId },
      },
    }
  })
