import { asc, eq, sql } from 'drizzle-orm'
import { subscriptionState, subscriptionType } from '../schema/marketing.ts'
import { recordActivity } from './activity.ts'
import type { AccountContext } from './context.ts'
import { mutate, withAccount } from './index.ts'
import { onUnsubscribe } from './sequences.ts'

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
  ctx: AccountContext,
  contactId: string,
): Promise<SubscriptionRow[]> =>
  withAccount(ctx, (tx) =>
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
  ctx: AccountContext,
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
        accountId: ctx.accountId,
        contactId: input.contactId,
        subscriptionTypeId: input.typeId,
        state: input.state,
        source: input.source ?? 'app',
      })
      .onConflictDoUpdate({
        target: [subscriptionState.accountId, subscriptionState.contactId, subscriptionState.subscriptionTypeId],
        set: { state: input.state, changedAt: new Date(), source: input.source ?? 'app' },
      })

    // Opting out has to stop the outreach as well as the newsletter, or somebody
    // who unsubscribes keeps getting sequence mail for another fortnight.
    if (input.state === 'unsubscribed') {
      await onUnsubscribe(tx, ctx, { contactId: input.contactId, subscriptionTypeId: input.typeId })
    }

    await recordActivity(tx, ctx, {
      type: 'subscription_change',
      subject:
        input.state === 'unspecified'
          ? `has no answer on ${type.name}`
          : `${input.state} ${input.state === 'subscribed' ? 'to' : 'from'} ${type.name}`,
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

// ------------------------------------------------------- managing the types

export type SubscriptionTypeRow = {
  id: string
  name: string
  description: string | null
  isInternal: boolean
  subscribed: number
  unsubscribed: number
}

/** The types themselves, with how many contacts have said something about each.
 *  "Never specified" is deliberately not a count here: it is everybody else, and
 *  showing it as a number invites treating it as a third opt-in. A2. */
export const listSubscriptionTypes = async (ctx: AccountContext): Promise<SubscriptionTypeRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      name: string
      description: string | null
      is_internal: boolean
      subscribed: number
      unsubscribed: number
    }>(sql`
      select t.id, t.name, t.description, t.is_internal,
             count(*) filter (where s.state = 'subscribed')::int as subscribed,
             count(*) filter (where s.state = 'unsubscribed')::int as unsubscribed
        from subscription_type t
        left join subscription_state s on s.subscription_type_id = t.id
       group by t.id, t.name, t.description, t.is_internal
       order by t.name asc`)

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      isInternal: row.is_internal,
      subscribed: Number(row.subscribed),
      unsubscribed: Number(row.unsubscribed),
    }))
  })

export const createSubscriptionType = async (
  ctx: AccountContext,
  input: { name: string; description?: string | null; isInternal?: boolean },
): Promise<{ id: string }> =>
  mutate(ctx, 'subscription_type', async (tx) => {
    const name = input.name.trim()
    if (!name) throw new Error('A subscription type needs a name.')

    const [clash] = await tx
      .select({ id: subscriptionType.id })
      .from(subscriptionType)
      .where(sql`lower(${subscriptionType.name}) = lower(${name})`)
      .limit(1)
    if (clash) throw new Error(`There is already a subscription type called "${name}".`)

    const [created] = await tx
      .insert(subscriptionType)
      .values({
        accountId: ctx.accountId,
        name,
        description: input.description?.trim() || null,
        isInternal: input.isInternal ?? false,
      })
      .returning({ id: subscriptionType.id })
    if (!created) throw new Error('The subscription type could not be created.')

    return {
      result: { id: created.id },
      audit: { entity: 'subscription_type', entityId: created.id, action: 'create', before: null, after: { name } },
    }
  })

export const updateSubscriptionType = async (
  ctx: AccountContext,
  input: { id: string; name?: string; description?: string | null; isInternal?: boolean },
): Promise<void> =>
  mutate(ctx, 'subscription_type', async (tx) => {
    const [before] = await tx
      .select({
        name: subscriptionType.name,
        description: subscriptionType.description,
        isInternal: subscriptionType.isInternal,
      })
      .from(subscriptionType)
      .where(eq(subscriptionType.id, input.id))
      .limit(1)
    if (!before) throw new Error('That subscription type no longer exists.')

    const name = input.name?.trim()
    if (input.name !== undefined && !name) throw new Error('A subscription type needs a name.')

    await tx
      .update(subscriptionType)
      .set({
        ...(name ? { name } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        ...(input.isInternal !== undefined ? { isInternal: input.isInternal } : {}),
      })
      .where(eq(subscriptionType.id, input.id))

    return {
      result: undefined,
      audit: { entity: 'subscription_type', entityId: input.id, action: 'update', before, after: input },
    }
  })

/** Deleting a type deletes every opt-out recorded against it, and an opt-out is the
 *  one piece of consent state that must never be lost by accident. So the count is
 *  named and the caller has to say it meant it. */
export const deleteSubscriptionType = async (
  ctx: AccountContext,
  id: string,
  confirmUnsubscribes: number,
): Promise<{ discarded: number }> =>
  mutate(ctx, 'subscription_type', async (tx) => {
    const [found] = await tx
      .select({ name: subscriptionType.name })
      .from(subscriptionType)
      .where(eq(subscriptionType.id, id))
      .limit(1)
    if (!found) throw new Error('That subscription type no longer exists.')

    const [{ n = 0 } = { n: 0 }] = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from subscription_state
           where subscription_type_id = ${id} and state = 'unsubscribed'`,
    )
    const optOuts = Number(n)
    if (optOuts !== confirmUnsubscribes) {
      throw new Error(
        `${found.name} carries ${optOuts} opt-out${optOuts === 1 ? '' : 's'}, which would be discarded. Reload and confirm that number to delete it.`,
      )
    }

    await tx.delete(subscriptionState).where(eq(subscriptionState.subscriptionTypeId, id))
    await tx.delete(subscriptionType).where(eq(subscriptionType.id, id))

    return {
      result: { discarded: optOuts },
      audit: {
        entity: 'subscription_type',
        entityId: id,
        action: 'delete',
        before: { name: found.name, unsubscribes: optOuts },
        after: null,
      },
    }
  })
