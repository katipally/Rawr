import {
  capReached,
  claimEnrollmentRun,
  createStepTask,
  deferRun,
  ingestMessage,
  internalDomainOf,
  nextSendAt,
  recordSend,
  recordSendFailure,
  renderMergeFields,
  stopEnrollment,
  windowFor,
  type ClaimedRun,
  type AccountContext,
} from '@rawr/db'
import { createHash } from 'node:crypto'
import { RevokedError } from '../gmail.ts'
import { addProspect } from '../integrations/woodpecker.ts'
import { canSendFrom, gmailSender } from './gmail-sender.ts'
import { toEmailHtml, toEmailText } from './markdown-email.ts'
import type { Sender } from './sender.ts'

/** One step of one enrollment.
 *
 *  Everything that can stop or delay a send is checked here, in order, before any
 *  mail goes out: is this mailbox allowed to send, is the window open, has the cap
 *  been reached, has enough time passed since the last one. Each of those defers
 *  the run rather than failing it, because "not yet" is not an error. */

export type RunOutcome =
  | { ran: false; reason: string }
  | { ran: true; kind: 'email'; sendId: string }
  | { ran: true; kind: 'task'; taskId: string }
  | { ran: true; kind: 'handover'; detail: string }

const SENDERS: Record<string, Sender> = { gmail: gmailSender }

/** The values a merge field can use. Deliberately small: a template that can read
 *  any field would be a way to put anything from the CRM into a stranger's inbox. */
const mergeValues = (run: ClaimedRun): Record<string, string | null> => ({
  first_name: run.contactFirstName,
  last_name: run.contactLastName,
  full_name: [run.contactFirstName, run.contactLastName].filter(Boolean).join(' ') || null,
  email: run.contactEmail,
  company: run.companyName,
  sender_email: run.mailboxEmail,
  sequence: run.sequenceName,
})

export const runStep = async (ctx: AccountContext, enrollmentId: string): Promise<RunOutcome> => {
  const outcome = await claimEnrollmentRun(ctx, enrollmentId)
  // Somebody else has it, it stopped between the dispatch and now, or it could
  // never send and the claim has just stopped it for good. None is a failure
  // worth retrying, and the claim's own sentence says which.
  if (!outcome.claimed) return { ran: false, reason: outcome.reason }
  const run = outcome.claimed

  // Woodpecker is not a transport Rawr drives step by step: its campaign owns the
  // steps, the delays and the sending accounts. So the enrollment's whole job is
  // to hand the prospect over once, and everything after that arrives by webhook.
  if (run.sender === 'woodpecker') {
    const campaignId = run.settings.woodpeckerCampaignId
    if (!campaignId) {
      const error = 'This sequence sends through Woodpecker but names no campaign.'
      await recordSendFailure(ctx, { enrollmentId, stepId: null, mailboxId: run.mailboxId, error })
      return { ran: false, reason: error }
    }
    try {
      const handed = await addProspect(ctx, {
        campaignId,
        email: run.contactEmail,
        firstName: run.contactFirstName,
        lastName: run.contactLastName,
        companyName: run.companyName,
      })
      if (!handed.handed) {
        await recordSendFailure(ctx, { enrollmentId, stepId: null, mailboxId: run.mailboxId, error: handed.detail })
        return { ran: false, reason: handed.detail }
      }
      await stopEnrollment(ctx, enrollmentId, 'finished', handed.detail)
      return { ran: true, kind: 'handover', detail: handed.detail }
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      await recordSendFailure(ctx, { enrollmentId, stepId: null, mailboxId: run.mailboxId, error })
      return { ran: false, reason: error }
    }
  }

  if (!run.step) {
    // No step at this position: the sequence was shortened under a live
    // enrollment. Finish it rather than looping on a step that is not there.
    await recordSendFailure(ctx, {
      enrollmentId,
      stepId: null,
      mailboxId: run.mailboxId,
      error: 'The step this enrollment was waiting for no longer exists.',
    })
    return { ran: false, reason: 'The step no longer exists.' }
  }

  if (run.step.kind !== 'email') {
    const rendered = renderMergeFields(run.step.taskTitle ?? 'Follow up', mergeValues(run))
    const created = await createStepTask(ctx, {
      enrollmentId,
      contactId: run.contactId,
      title: rendered.text,
      body: run.step.taskBody ? renderMergeFields(run.step.taskBody, mergeValues(run)).text : null,
      // Whoever put the contact in the sequence owns the follow-up, falling back
      // to whoever owns the sequence once they have left.
      assigneeId: run.enrolledBy ?? run.sequenceOwnerId ?? ctx.actorId,
    })
    return { ran: true, kind: 'task', taskId: created.taskId }
  }

  const refusal = canSendFrom(run)
  if (refusal) {
    await recordSendFailure(ctx, { enrollmentId, stepId: run.step.id, mailboxId: run.mailboxId, error: refusal })
    return { ran: false, reason: refusal }
  }

  const window = windowFor(run)
  const now = new Date()

  if (capReached(run.sentToday, run.mailboxDailyCap)) {
    // Tomorrow's opening, not tomorrow's clock: a cap that resets at midnight UTC
    // would let a London mailbox send its whole day's allowance at 1am.
    const tomorrow = nextSendAt({
      after: new Date(now.getTime() + 12 * 3_600_000),
      delayDays: 0,
      delayHours: 0,
      window,
    })
    await deferRun(ctx, enrollmentId, tomorrow)
    return { ran: false, reason: `${run.mailboxEmail} has sent its ${run.mailboxDailyCap} for today.` }
  }

  const due = nextSendAt({
    after: now,
    delayDays: 0,
    delayHours: 0,
    window,
    lastSentAt: run.mailboxLastSentAt,
    minGapSeconds: run.mailboxMinGapSeconds,
  })
  if (due.getTime() > now.getTime()) {
    await deferRun(ctx, enrollmentId, due)
    return { ran: false, reason: 'Outside the sending window, or too soon after the last one.' }
  }

  const values = mergeValues(run)
  // Which subject this enrollment gets, when the step is testing two. Derived
  // from the ids rather than drawn at random, so a retry after a crash sends the
  // line the first attempt chose rather than a different one.
  const variant = run.step.subjectB ? (evenHash(`${enrollmentId}:${run.step.id}`) ? 'a' : 'b') : null
  const chosen = variant === 'b' ? (run.step.subjectB ?? run.step.subject) : run.step.subject
  const subject = renderMergeFields(chosen ?? '', values)
  // The step is written in Markdown, and the merge fields go in before it is
  // rendered: a contact called *Acme* must not turn the rest of the mail italic.
  const source = renderMergeFields(run.step.bodyText ?? '', values)
  const html = run.step.bodyHtml
    ? renderMergeFields(run.step.bodyHtml, values)
    : { text: toEmailHtml(source.text), missing: [] as string[] }
  const text = { text: toEmailText(source.text), missing: source.missing }

  const missing = [...new Set([...subject.missing, ...text.missing, ...html.missing])]
  if (missing.length > 0) {
    // Better a stopped enrollment somebody can see than "Hi ," in a prospect's
    // inbox. The template can give the field a fallback and the contact can be
    // enrolled again.
    const error = `Nothing to put in ${missing.join(', ')} for this contact. Give the field a fallback, like {{first_name|there}}.`
    await recordSendFailure(ctx, { enrollmentId, stepId: run.step.id, mailboxId: run.mailboxId, error })
    return { ran: false, reason: error }
  }

  const sender = SENDERS[run.sender]
  if (!sender) {
    const error = `No sender is configured for "${run.sender}".`
    await recordSendFailure(ctx, { enrollmentId, stepId: run.step.id, mailboxId: run.mailboxId, error })
    return { ran: false, reason: error }
  }

  // Reply into the conversation the first step started, when the sequence asks
  // for it and there is one to reply into.
  const inThread = run.settings.replyInThread && run.rootInternetMessageId ? run.rootInternetMessageId : null

  let sent: Awaited<ReturnType<Sender['send']>>
  try {
    sent = await sender.send(ctx, run, {
      subject: subject.text,
      text: text.text,
      html: html.text || null,
      inReplyTo: inThread,
      references: inThread ? [inThread] : [],
    })
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    // A withdrawn grant is not this enrollment's fault and stops every enrollment
    // on that mailbox, so it is raised rather than recorded here.
    if (cause instanceof RevokedError) throw cause
    await recordSendFailure(ctx, { enrollmentId, stepId: run.step.id, mailboxId: run.mailboxId, error })
    return { ran: false, reason: error }
  }

  // The sent copy is stored the same way an incoming one is, so it appears in the
  // thread, on the record and in the inbox rather than only in a sequence report.
  let threadId: string | null = null
  let messageId: string | null = null
  let activityId: string | null = null
  if (sent.providerMessageId) {
    const stored = await ingestMessage(ctx, {
      incoming: {
        providerThreadId: run.providerThreadId ?? sent.providerMessageId,
        providerMessageId: sent.providerMessageId,
        subject: subject.text,
        from: run.mailboxEmail,
        to: [run.contactEmail],
        cc: [],
        sentAt: new Date(),
        snippet: text.text.slice(0, 200),
        internetMessageId: sent.internetMessageId,
        inReplyTo: inThread,
        references: inThread ? [inThread] : [],
        body: { text: text.text, html: html.text || null },
        hasAttachments: false,
      },
      ownerEmail: run.mailboxEmail,
      mailboxId: run.mailboxId,
      internalDomain: await internalDomainOf(ctx),
      blocked: new Set(),
      origin: { sequenceId: run.sequenceId, sequenceName: run.sequenceName },
    })
    if (stored.stored) {
      threadId = stored.threadId
      messageId = stored.messageId
      activityId = stored.activityId
    }
  }

  const recorded = await recordSend(ctx, {
    enrollmentId,
    stepId: run.step.id,
    mailboxId: run.mailboxId,
    providerMessageId: sent.providerMessageId,
    internetMessageId: sent.internetMessageId,
    variant,
    threadId,
    messageId,
    activityId,
    token: sent.sendToken,
    links: sent.links,
    subject: subject.text,
    contactId: run.contactId,
  })

  return { ran: true, kind: 'email', sendId: recorded.sendId }
}

/** A stable coin toss for a string. The same enrollment and step always land the
 *  same way, which is what makes a retried send repeat itself rather than switch
 *  subjects halfway through a conversation. */
const evenHash = (key: string): boolean => createHash('sha256').update(key).digest()[0]! % 2 === 0
