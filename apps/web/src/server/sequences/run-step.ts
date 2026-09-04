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
  windowFor,
  type ClaimedRun,
  type WorkspaceContext,
} from '@rawr/db'
import { RevokedError } from '../gmail.ts'
import { canSendFrom, gmailSender } from './gmail-sender.ts'
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

export const runStep = async (ctx: WorkspaceContext, enrollmentId: string): Promise<RunOutcome> => {
  const run = await claimEnrollmentRun(ctx, enrollmentId)
  // Somebody else has it, or it stopped between the dispatch and now. Neither is
  // a failure worth retrying.
  if (!run) return { ran: false, reason: 'Not due, or already being run.' }

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
      assigneeId: ctx.actorId,
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
    lastSentAt: run.lastSentAt,
    minGapSeconds: run.mailboxMinGapSeconds,
  })
  if (due.getTime() > now.getTime()) {
    await deferRun(ctx, enrollmentId, due)
    return { ran: false, reason: 'Outside the sending window, or too soon after the last one.' }
  }

  const values = mergeValues(run)
  const subject = renderMergeFields(run.step.subject ?? '', values)
  const text = renderMergeFields(run.step.bodyText ?? '', values)
  const html = run.step.bodyHtml ? renderMergeFields(run.step.bodyHtml, values) : null

  const missing = [...new Set([...subject.missing, ...text.missing, ...(html?.missing ?? [])])]
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
      html: html?.text ?? null,
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
        body: { text: text.text, html: html?.text ?? null },
        hasAttachments: false,
      },
      ownerEmail: run.mailboxEmail,
      mailboxId: run.mailboxId,
      internalDomain: await internalDomainOf(ctx),
      blocked: new Set(),
    })
    if (stored.stored) threadId = stored.threadId
  }

  const recorded = await recordSend(ctx, {
    enrollmentId,
    stepId: run.step.id,
    mailboxId: run.mailboxId,
    providerMessageId: sent.providerMessageId,
    internetMessageId: sent.internetMessageId,
    threadId,
    token: sent.sendToken,
    links: sent.links,
    subject: subject.text,
    contactId: run.contactId,
  })

  return { ran: true, kind: 'email', sendId: recorded.sendId }
}
