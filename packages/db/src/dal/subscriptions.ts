import { asc, eq, sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import { randomToken } from '../internal/crypto.ts'
import { subscriptionState, subscriptionType } from '../schema/marketing.ts'
import { recordActivity } from './activity.ts'
import type { AccountContext } from './context.ts'
import { mutate, withAccount, writeAudit } from './index.ts'
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
  doubleOptIn: boolean
  subscribed: number
  unsubscribed: number
  /** Opt-ins asked for and not yet confirmed. Only ever above zero on a type that
   *  asks, and the number somebody needs to judge whether the confirmation mail is
   *  arriving at all. */
  awaitingConfirmation: number
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
      double_opt_in: boolean
      subscribed: number
      unsubscribed: number
      awaiting: number
    }>(sql`
      select t.id, t.name, t.description, t.is_internal, t.double_opt_in,
             count(*) filter (where s.state = 'subscribed')::int as subscribed,
             count(*) filter (where s.state = 'unsubscribed')::int as unsubscribed,
             count(*) filter (where s.confirm_token is not null)::int as awaiting
        from subscription_type t
        left join subscription_state s on s.subscription_type_id = t.id
       group by t.id, t.name, t.description, t.is_internal, t.double_opt_in
       order by t.name asc`)

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      isInternal: row.is_internal,
      doubleOptIn: row.double_opt_in,
      subscribed: Number(row.subscribed),
      unsubscribed: Number(row.unsubscribed),
      awaitingConfirmation: Number(row.awaiting),
    }))
  })

export const createSubscriptionType = async (
  ctx: AccountContext,
  input: { name: string; description?: string | null; isInternal?: boolean; doubleOptIn?: boolean },
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
        doubleOptIn: input.doubleOptIn ?? false,
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
  input: {
    id: string
    name?: string
    description?: string | null
    isInternal?: boolean
    doubleOptIn?: boolean
  },
): Promise<void> =>
  mutate(ctx, 'subscription_type', async (tx) => {
    const [before] = await tx
      .select({
        name: subscriptionType.name,
        description: subscriptionType.description,
        isInternal: subscriptionType.isInternal,
        doubleOptIn: subscriptionType.doubleOptIn,
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
        ...(input.doubleOptIn !== undefined ? { doubleOptIn: input.doubleOptIn } : {}),
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

// ----------------------------------------------------------- double opt-in

export type OptInRequest =
  | { pending: false }
  /** Everything the caller needs to send the confirmation, so it does not have to
   *  read back the row it just wrote. */
  | { pending: true; token: string; typeName: string; contactEmail: string; contactFirstName: string | null }

/** A form asking somebody to be subscribed.
 *
 *  On an ordinary type that is the subscription: the tick is the consent. On a
 *  type that asks for confirmation it is only the request, and the state stays
 *  where it was until the link in the mail is clicked. Nothing anywhere has to
 *  learn a fourth state, because "asked and not answered" is exactly what
 *  'unspecified' already means, and every send, list and push already excludes it.
 *
 *  Already subscribed is left alone: re-confirming somebody who is in would let a
 *  form fill quietly reset consent they had already given. */
export const requestOptIn = async (
  ctx: AccountContext,
  input: { contactId: string; typeId: string; source?: string },
): Promise<OptInRequest> => {
  const [type] = await withAccount(ctx, (tx) =>
    tx
      .select({ name: subscriptionType.name, doubleOptIn: subscriptionType.doubleOptIn })
      .from(subscriptionType)
      .where(eq(subscriptionType.id, input.typeId))
      .limit(1),
  )
  if (!type) return { pending: false }

  if (!type.doubleOptIn) {
    await setSubscription(ctx, {
      contactId: input.contactId,
      typeId: input.typeId,
      state: 'subscribed',
      source: input.source ?? 'form',
    })
    return { pending: false }
  }

  const token = randomToken()
  return withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{
      state: SubscriptionState
      email: string | null
      first_name: string | null
    }>(sql`
      with asked as (
        insert into subscription_state
          (account_id, contact_id, subscription_type_id, state, source, confirm_token)
        values (${ctx.accountId}, ${input.contactId}, ${input.typeId}, 'unspecified',
                ${input.source ?? 'form'}, ${token})
        on conflict (account_id, contact_id, subscription_type_id) do update
          -- The state is deliberately untouched: this is a request, not a change.
          set confirm_token = case when subscription_state.state = 'subscribed'
                                   then subscription_state.confirm_token
                                   else excluded.confirm_token end
        returning contact_id, state, confirm_token
      )
      select asked.state, c.email, c.first_name
        from asked join contact c on c.id = asked.contact_id
       where asked.confirm_token = ${token}`)

    // No row means they were already subscribed, so nothing was asked.
    if (!row?.email) return { pending: false }
    return {
      pending: true,
      token,
      typeName: type.name,
      contactEmail: row.email,
      contactFirstName: row.first_name,
    }
  })
}

export const subscriptionAccountForToken = async (token: string): Promise<string | null> => {
  const [row] = await appDb.execute<{ id: string }>(
    sql`select * from rawr.account_for_confirm_token(${token}::text)`,
  )
  return row?.id ?? null
}

export type ConfirmTarget = { typeName: string; contactEmail: string }

/** What the confirm page says before anybody presses anything. Null for a token
 *  that has been used or was never one, and the page says the same thing either
 *  way so this cannot be used to test tokens. */
export const confirmTarget = async (
  ctx: AccountContext,
  token: string,
): Promise<ConfirmTarget | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{ name: string; email: string | null }>(sql`
      select t.name, c.email
        from subscription_state s
        join subscription_type t on t.id = s.subscription_type_id
        join contact c on c.id = s.contact_id
       where s.confirm_token = ${token}
       limit 1`)
    return row?.email ? { typeName: row.name, contactEmail: row.email } : null
  })

/** The click that turns a request into consent.
 *
 *  The token is cleared in the same statement that subscribes, so a link in an old
 *  mail stops working the moment it is used and pressing twice confirms once. */
export const confirmSubscription = async (
  ctx: AccountContext,
  token: string,
): Promise<ConfirmTarget | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{
      contact_id: string
      subscription_type_id: string
      name: string
      email: string | null
    }>(sql`
      update subscription_state s
         set state = 'subscribed',
             confirmed_at = now(),
             changed_at = now(),
             source = 'double_opt_in',
             confirm_token = null
        from subscription_type t, contact c
       where s.confirm_token = ${token}
         and t.id = s.subscription_type_id
         and c.id = s.contact_id
      returning s.contact_id, s.subscription_type_id, t.name, c.email`)

    // A token already used, or never one. The caller says the same thing either
    // way, so this cannot be used to test tokens.
    if (!row) return null

    await recordActivity(tx, ctx, {
      type: 'subscription_change',
      subject: `confirmed their subscription to ${row.name}`,
      payload: { typeId: row.subscription_type_id, from: 'unspecified', to: 'subscribed' },
      links: [{ entityType: 'contact', entityId: row.contact_id }],
    })

    await writeAudit(tx, ctx, {
      entity: 'subscription_state',
      entityId: row.contact_id,
      action: 'confirm',
      before: { state: 'unspecified', typeId: row.subscription_type_id },
      after: { state: 'subscribed', typeId: row.subscription_type_id },
    })

    return { typeName: row.name, contactEmail: row.email ?? '' }
  })

// -------------------------------------------------------- consent records

export const CONSENT_PAGE = 50

export type ConsentRecordRow = {
  id: string
  visitorId: string
  categories: { necessary: boolean; analytics: boolean; advertisement: boolean }
  policyVersion: string
  userAgent: string | null
  at: Date
}

/** The cookie choices strangers actually made, newest first.
 *
 *  Append-only by design, so this is evidence rather than a settings screen: it
 *  says what was lawful when a given day's data was collected. Offset paged and
 *  bounded, because the table is one row per choice per visitor and grows with
 *  traffic rather than with the account. */
export const listConsentRecords = async (
  ctx: AccountContext,
  input: { limit?: number | undefined; offset?: number | undefined } = {},
): Promise<{ rows: ConsentRecordRow[]; hasMore: boolean }> =>
  withAccount(ctx, async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? CONSENT_PAGE, 1), 200)
    const offset = Math.max(input.offset ?? 0, 0)
    const rows = await tx.execute<{
      id: string
      visitor_id: string
      categories: ConsentRecordRow['categories']
      policy_version: string
      user_agent: string | null
      at: Date
    }>(sql`
      select id, visitor_id, categories, policy_version, user_agent, at
        from consent_record
       order by at desc, id desc
       limit ${limit + 1} offset ${offset}`)

    return {
      rows: rows.slice(0, limit).map((row) => ({
        id: row.id,
        visitorId: row.visitor_id,
        categories: row.categories,
        policyVersion: row.policy_version,
        userAgent: row.user_agent,
        at: new Date(row.at),
      })),
      hasMore: rows.length > limit,
    }
  })
