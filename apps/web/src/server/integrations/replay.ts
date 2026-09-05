import {
  endpointsFor,
  listWebhookEndpoints,
  promoteFieldToHot,
  type Replayable,
  type WorkspaceContext,
} from '@rawr/db'
import { syncMailbox } from '../gmail.ts'
import { enrichRecord, enrichCompanyRecord } from './index.ts'
import { postToSlack } from './slack.ts'
import { addProspect } from './woodpecker.ts'
import { deliverWebhook, WEBHOOK_JOB } from '../webhooks.ts'

/** F6 §1 and its edge case: "a dead-lettered item is replayed twice → the
 *  idempotency key makes the second a no-op."
 *
 *  Replay is per job family rather than generic, because a generic "re-send this
 *  payload" would happily re-run something whose preconditions have since changed:
 *  the contact was deleted, the form was removed, the field was purged. Each family
 *  below knows how to check that. A family with no replay path says so by name
 *  rather than a button that quietly does nothing.
 *
 *  Replaying is safe to do twice because the work underneath is keyed, not because
 *  this function remembers. */

export type ReplayOutcome = { replayed: true; detail: string }

export const replayJob = async (
  ctx: WorkspaceContext,
  claimed: Replayable,
): Promise<ReplayOutcome> => {
  const payload = (claimed.payload ?? {}) as Record<string, unknown>

  switch (claimed.jobName) {
    case 'slack.form-submission': {
      const body = payload.body as { text: string; blocks: unknown[]; channel?: string } | undefined
      const submissionId = typeof payload.submissionId === 'string' ? payload.submissionId : null
      if (!body || !submissionId) {
        throw new Error('That Slack failure has no message left to re-send.')
      }
      // Keyed on the submission, so the lead is announced once however many times
      // somebody presses replay.
      const result = await postToSlack(ctx, {
        key: `slack:submission:${submissionId}`,
        jobName: 'slack.form-submission',
        body,
        payload,
      })
      return { replayed: true, detail: result.detail }
    }

    case WEBHOOK_JOB: {
      const endpointId = typeof payload.endpointId === 'string' ? payload.endpointId : null
      const body = typeof payload.body === 'string' ? payload.body : null
      const event = typeof payload.event === 'string' ? payload.event : null
      if (!endpointId || !body || !event) {
        throw new Error('That delivery has no payload left to re-send.')
      }
      // Read again rather than replayed from the payload: the endpoint may have
      // been switched off, moved, or had its key rolled since it failed, and
      // re-sending to the old address with the old key would fail identically
      // forever. A deleted endpoint says so instead of quietly doing nothing.
      const endpoint = (await listWebhookEndpoints(ctx)).find((row) => row.id === endpointId)
      if (!endpoint) throw new Error('That endpoint has since been deleted.')
      if (!endpoint.isActive) throw new Error(`${endpoint.name} is switched off. Turn it on before replaying.`)

      const [job] = await endpointsFor(ctx, event).then((rows) => rows.filter((row) => row.id === endpointId))
      if (!job) throw new Error(`${endpoint.name} no longer subscribes to ${event}.`)

      await deliverWebhook({
        workspaceId: ctx.workspaceId,
        endpointId,
        url: job.url,
        secret: job.secret,
        event,
        body,
      })
      return { replayed: true, detail: `Re-sent ${event} to ${endpoint.name}.` }
    }

    case 'slack.booking-no-conference':
    case 'slack.stage-change': {
      const body = payload.body as { text: string; blocks: unknown[]; channel?: string } | undefined
      const key = typeof payload.idempotencyKey === 'string' ? payload.idempotencyKey : null
      if (!body || !key) throw new Error('That Slack failure has no message left to re-send.')
      const result = await postToSlack(ctx, { key, jobName: claimed.jobName, body, payload })
      return { replayed: true, detail: result.detail }
    }

    case 'apollo.enrich':
    case 'clay.enqueue':
    case 'lusha.enrich': {
      // Enriching again is safe however many times it runs: a provider is only
      // asked about fields that are still empty, and nothing overwrites a human.
      const contactId = typeof payload.contactId === 'string' ? payload.contactId : null
      if (contactId) {
        const result = await enrichRecord(ctx, contactId)
        return { replayed: true, detail: result.detail }
      }
      const companyId = typeof payload.companyId === 'string' ? payload.companyId : null
      if (companyId) {
        const result = await enrichCompanyRecord(ctx, companyId)
        return { replayed: true, detail: result.detail }
      }
      throw new Error('That enrichment failure names no contact or company, so there is nothing to enrich.')
    }

    case 'woodpecker.enroll': {
      const campaignId = typeof payload.campaignId === 'number' ? payload.campaignId : null
      const email = typeof payload.email === 'string' ? payload.email : null
      if (!campaignId || !email) throw new Error('That hand-over names no campaign and address to retry.')
      // Woodpecker keys a prospect on its address within a campaign, so handing
      // the same person over twice updates the row rather than mailing them twice.
      const outcome = await addProspect(ctx, {
        campaignId,
        email,
        firstName: typeof payload.firstName === 'string' ? payload.firstName : null,
        lastName: typeof payload.lastName === 'string' ? payload.lastName : null,
        companyName: typeof payload.companyName === 'string' ? payload.companyName : null,
      })
      return { replayed: true, detail: outcome.detail }
    }

    case 'woodpecker.campaigns': {
      throw new Error(
        'Reading the campaign list is not work to replay: open a Woodpecker sequence and the list is fetched again.',
      )
    }

    case 'brevo.upsert_contact':
    case 'brevo.push_list': {
      // The push is keyed on the segment and its member set, so re-running it is
      // the safe operation; what is not safe is guessing which segment when the
      // payload does not say.
      throw new Error(
        'A Brevo push is replayed by pushing the segment again from the Segments screen, which is keyed on the same members and so cannot double-send.',
      )
    }

    case 'field-index.create': {
      const fieldId = typeof payload.fieldId === 'string' ? payload.fieldId : null
      if (!fieldId) {
        throw new Error('That index failure names no field, so there is nothing to rebuild.')
      }
      await promoteFieldToHot(ctx, fieldId)
      return { replayed: true, detail: 'The index was requested again; the worker builds it within the minute.' }
    }

    case 'mail.sync': {
      const mailboxId = typeof payload.mailboxId === 'string' ? payload.mailboxId : null
      if (!mailboxId) throw new Error('That sync failure names no mailbox.')
      const outcome = await syncMailbox(ctx, mailboxId)
      return {
        replayed: true,
        detail: `${outcome.read} read: ${outcome.stored} new, ${outcome.alreadyHad} already had, ${outcome.skipped} refused.`,
      }
    }

    default:
      throw new Error(
        `${claimed.jobName} has no replay path. Every job that can be replayed is listed in replay.ts; if this one should be, it belongs there.`,
      )
  }
}
