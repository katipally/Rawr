import { accountSlugFor, armedFor, endpointsFor, eventNameFor, type AccountContext, type UpdateResult } from '@rawr/db'
import { describe, logError } from './log.ts'
import { reportEvent } from './automations.ts'
import { announceStageChange } from './stage-alerts.ts'

/** The events a write to a record causes. Every door a record comes through (the
 *  create and update dialogs in the app, and the MCP tools an agent calls) reports
 *  through these two, so a webhook, a rule or a Slack alert does not depend on
 *  which door was used. */

export type Actor = { accountSlug: string; displayName: string }

/** Captures and background writers have no person to name, so they pass only the account slug. */
export const recordCreated = (
  ctx: AccountContext,
  actor: Pick<Actor, 'accountSlug'>,
  objectKey: string,
  created: { id: string; displayName?: string | undefined },
): void => {
  reportEvent(ctx, {
    trigger: 'record_created',
    objectKey,
    entityId: created.id,
    displayName: created.displayName,
    accountSlug: actor.accountSlug,
  })
}

/** For writers with no person behind them. Never throws: the write already committed, and
 *  a failed announcement must not fail a sent mail or a landed import. */
export const recordsCreated = async (ctx: AccountContext, objectKey: string, ids: string[]): Promise<void> => {
  if (ids.length === 0) return
  try {
    // A large import must not pay two queries per record to learn that nothing listens.
    const [rules, endpoints] = await Promise.all([
      armedFor(ctx, 'record_created', objectKey),
      endpointsFor(ctx, eventNameFor(objectKey, 'record_created')),
    ])
    if (rules.length === 0 && endpoints.length === 0) return
    const accountSlug = await accountSlugFor(ctx)
    for (const id of ids) recordCreated(ctx, { accountSlug }, objectKey, { id })
  } catch (cause) {
    logError({ msg: 'record_created could not be announced', objectKey, count: ids.length, error: describe(cause) })
  }
}

export const recordUpdated = (
  ctx: AccountContext,
  actor: Actor,
  objectKey: string,
  id: string,
  result: UpdateResult,
): void => {
  announceStageChange(ctx, actor.accountSlug, result.stageChange, actor.displayName)
  // A stage move and a lifecycle move are two triggers on one write. updateRecord
  // reports one of them per write because they are different columns.
  const trigger = result.stageChange ? 'stage_changed' : result.lifecycleChanged ? 'lifecycle_changed' : null
  if (!trigger) return
  reportEvent(ctx, {
    trigger,
    objectKey,
    entityId: id,
    displayName: result.displayName,
    accountSlug: actor.accountSlug,
  })
}
