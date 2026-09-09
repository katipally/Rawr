import { isUuid, listPipelines, once, readCredentials, recordHealth, type AccountContext } from '@rawr/db'
import { devIntegrationsEnabled } from '~/lib/env.ts'
import { attempt, json, providerError, type ConnectionTest } from './provider.ts'

/** F6 §5. Slack, used by F3 for the thing Trevor flagged first: a form fill from a
 *  real prospect lands in the channel, and that stops at cutover.
 *
 *  One field takes either a bot token or an incoming webhook URL, because nobody
 *  should have to know which kind of Slack app they were handed. */

type SlackConfig = { channel?: string; stageAlerts?: string }

export type SlackCredentials = {
  botToken: string | null
  webhookUrl: string | null
  channel: string | null
  integrationId: string | null
  stagePipelines: string[]
}

export const slackCredentials = async (ctx: AccountContext): Promise<SlackCredentials | null> => {
  const stored = await readCredentials(ctx, 'slack')
  const config = (stored?.config ?? {}) as SlackConfig
  const secret = stored?.secret ?? null

  // Told apart by shape, so one field takes either.
  const isWebhook = secret?.startsWith('https://hooks.slack.com/') ?? false
  const botToken = secret && !isWebhook ? secret : null
  const webhookUrl = isWebhook ? secret : null

  // The dev provider posts nothing; it only needs to reach postToSlack's branch.
  if (!botToken && !webhookUrl && !devIntegrationsEnabled) return null

  // A pipeline is named the way a person types it, "Enterprise", and an id is
  // accepted too for anything already stored that way. Resolved here, once per
  // call, so the check on every stage move is a set lookup.
  const wanted = (config.stageAlerts ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const named = wanted.filter((entry) => !isUuid(entry))
  const byName = named.length > 0 ? await listPipelines(ctx) : []
  const stagePipelines = wanted.flatMap((entry) =>
    isUuid(entry)
      ? [entry]
      : byName.filter((pipeline) => pipeline.name.toLowerCase() === entry.toLowerCase()).map((pipeline) => pipeline.id),
  )

  return {
    botToken,
    webhookUrl,
    channel: config.channel ?? null,
    integrationId: stored?.id ?? null,
    stagePipelines,
  }
}

export const testSlack = async (ctx: AccountContext): Promise<ConnectionTest> => {
  try {
    if (devIntegrationsEnabled) {
      await recordHealth(ctx, 'slack', { ok: true })
      return { ok: true, detail: 'Development provider. Nothing is posted to Slack.' }
    }

    const creds = await slackCredentials(ctx)
    if (!creds) {
      const detail =
        'Slack is not connected. Paste a bot token or an incoming webhook URL.'
      await recordHealth(ctx, 'slack', { ok: false, error: detail })
      return { ok: false, detail }
    }

    if (creds.botToken) {
      // auth.test names the account and the bot, which is exactly what somebody
      // wants to see before trusting that leads will arrive.
      const answer = await json<{ ok?: boolean; team?: string; user?: string; error?: string }>({
        url: 'https://slack.com/api/auth.test',
        method: 'POST',
        headers: { authorization: `Bearer ${creds.botToken}` },
        body: {},
      })
      if (!answer.ok) throw providerError(`Slack refused the token: ${answer.error ?? 'unknown error'}.`, { disconnected: true })
      await recordHealth(ctx, 'slack', { ok: true })
      return {
        ok: true,
        detail: `Connected to ${answer.team ?? 'the account'} as ${answer.user ?? 'the Rawr bot'}. Default channel ${creds.channel ?? 'is not set, so each form must name one'}.`,
      }
    }

    // A webhook has no auth endpoint, so the only honest test is a real post. It
    // is marked as a test so nobody in the channel wonders what it was.
    await json({
      url: creds.webhookUrl!,
      method: 'POST',
      body: { text: 'Rawr connection test. If you can see this, form fills will arrive here.' },
    })
    await recordHealth(ctx, 'slack', { ok: true })
    return {
      ok: true,
      detail:
        'The webhook accepted a test message; check the channel. A webhook has no health check and no deep-link unfurl, which is the cost of a webhook rather than a full Slack app.',
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    await recordHealth(ctx, 'slack', {
      ok: false,
      error: message,
      disconnected: (cause as { disconnected?: boolean }).disconnected === true,
    })
    return { ok: false, detail: message }
  }
}

export type SlackBody = { channel?: string | undefined; text: string; blocks: unknown[] }

/** One post, at most once per key, with the retry and dead-letter behaviour every
 *  other provider gets. */
export const postToSlack = async (
  ctx: AccountContext,
  input: { key: string; jobName: string; body: SlackBody; payload: Record<string, unknown> },
): Promise<{ posted: boolean; detail: string }> => {
  const creds = await slackCredentials(ctx)
  if (!creds) {
    throw providerError(
      'Slack is not configured. Set a bot token or a webhook URL in Settings, under Integrations.',
    )
  }

  const outcome = await once(
    ctx,
    { key: input.key, operation: input.jobName, integrationId: creds.integrationId },
    async () => {
      if (devIntegrationsEnabled) return { posted: true, dev: true }

      await attempt({ ctx, kind: 'slack', jobName: input.jobName, payload: input.payload }, async () => {
        const target = creds.botToken ? 'https://slack.com/api/chat.postMessage' : creds.webhookUrl!
        const body = creds.botToken
          ? { ...input.body, channel: input.body.channel ?? creds.channel ?? undefined }
          : input.body

        const answer = await json<{ ok?: boolean; error?: string } | null>({
          url: target,
          method: 'POST',
          headers: creds.botToken ? { authorization: `Bearer ${creds.botToken}` } : {},
          body,
        })
        // A webhook answers "ok" as plain text and json() gives null; the Web API
        // reports failure inside a 200, which a status check alone would miss.
        if (creds.botToken && answer && answer.ok === false) {
          throw providerError(`Slack refused the message: ${answer.error ?? 'unknown error'}.`, {
            disconnected: answer.error === 'invalid_auth' || answer.error === 'account_inactive',
          })
        }
        return null
      })

      return { posted: true, dev: false }
    },
  )

  await recordHealth(ctx, 'slack', { ok: true })
  return {
    posted: true,
    detail: outcome.fresh ? 'Posted.' : 'Already posted; the idempotency key made this a no-op.',
  }
}

/** F6 §5's second use: deal stage-change alerts, opt-in per pipeline. Off unless a
 *  pipeline id is listed, because a channel that announces every move on every deal
 *  is a channel people mute. */
export const shouldAnnounceStage = (creds: SlackCredentials | null, pipelineId: string | null): boolean =>
  Boolean(creds && pipelineId && creds.stagePipelines.includes(pipelineId))
