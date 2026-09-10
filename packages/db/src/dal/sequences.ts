import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { appDb } from '../internal/pool.ts'
import { randomToken } from '../internal/crypto.ts'
import { mailbox } from '../schema/messaging.ts'
import { contact } from '../schema/records.ts'
import { userAccount } from '../schema/identity.ts'
import {
  emailTemplate,
  sequence,
  sequenceEnrollment,
  sequenceEvent,
  sequenceLink,
  sequenceSend,
  sequenceStep,
  type SequenceSettings } from '../schema/sequences.ts'
import { contactLabels, linksForContacts, recordActivity } from './activity.ts'
import type { AccountContext } from './context.ts'
import { mutate, withAccount, type Tx } from './index.ts'
import { DEFAULT_WINDOW, nextSendAt, type SendWindow } from './sequence-rules.ts'
import { createTask } from './tasks.ts'

/** Sequences: the definitions, who is in them, and every reason one stops.
 *
 *  The engine that actually sends lives in the web app, because it needs Google
 *  credentials. This is the state it reads and writes, and the rules about that
 *  state: one live enrollment per contact per sequence, a lease so two workers
 *  cannot send the same step twice, and a stop for every way a conversation ends. */

export type SequenceState = 'draft' | 'active' | 'paused' | 'archived'
export type StepKind = 'email' | 'call' | 'linkedin' | 'task'
export type EnrollmentState =
  | 'active'
  | 'waiting_task'
  | 'paused'
  | 'finished'
  | 'replied'
  | 'bounced'
  | 'unsubscribed'
  | 'failed'
  | 'removed'

/** Terminal, in the sense that the scheduler will never pick it up again. */
const STOPPED: EnrollmentState[] = ['finished', 'replied', 'bounced', 'unsubscribed', 'failed', 'removed']

export const DEFAULT_SEQUENCE_SETTINGS: SequenceSettings = {
  sendWindow: DEFAULT_WINDOW,
  stopOnReply: true,
  stopOnBounce: true,
  stopOnUnsubscribe: true,
  trackOpens: true,
  trackClicks: true,
  subscriptionTypeId: null,
  replyInThread: true,
  woodpeckerCampaignId: null,
}

export type SequenceStep = {
  id: string
  position: number
  kind: StepKind
  delayDays: number
  delayHours: number
  subject: string | null
  /** A second subject to test. Null means no test. */
  subjectB: string | null
  bodyHtml: string | null
  bodyText: string | null
  taskTitle: string | null
  taskBody: string | null
}

export type SequenceRow = {
  id: string
  name: string
  description: string | null
  state: SequenceState
  sender: 'gmail' | 'woodpecker'
  ownerId: string | null
  ownerName: string | null
  settings: SequenceSettings
  stepCount: number
  /** How it is doing, counted from the enrollments rather than kept as a running
   *  total, because a running total drifts and nobody notices. */
  stats: SequenceStats
}

export type SequenceStats = {
  active: number
  finished: number
  replied: number
  bounced: number
  unsubscribed: number
  sent: number
  opened: number
  clicked: number
}

const emptyStats = (): SequenceStats => ({
  active: 0,
  finished: 0,
  replied: 0,
  bounced: 0,
  unsubscribed: 0,
  sent: 0,
  opened: 0,
  clicked: 0,
})

const statsSql = sql`
  json_build_object(
    'active',       (select count(*) from sequence_enrollment e where e.sequence_id = s.id and e.state in ('active','waiting_task','paused')),
    'finished',     (select count(*) from sequence_enrollment e where e.sequence_id = s.id and e.state = 'finished'),
    'replied',      (select count(*) from sequence_enrollment e where e.sequence_id = s.id and e.state = 'replied'),
    'bounced',      (select count(*) from sequence_enrollment e where e.sequence_id = s.id and e.state = 'bounced'),
    'unsubscribed', (select count(*) from sequence_enrollment e where e.sequence_id = s.id and e.state = 'unsubscribed'),
    'sent',         (select count(*) from sequence_send d join sequence_enrollment e on e.id = d.enrollment_id
                      where e.sequence_id = s.id and d.state = 'sent'),
    'opened',       (select count(*) from sequence_send d join sequence_enrollment e on e.id = d.enrollment_id
                      where e.sequence_id = s.id and d.open_count > 0),
    'clicked',      (select count(*) from sequence_send d join sequence_enrollment e on e.id = d.enrollment_id
                      where e.sequence_id = s.id and d.click_count > 0)
  )`

export const listSequences = async (ctx: AccountContext): Promise<SequenceRow[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      name: string
      description: string | null
      state: SequenceState
      sender: 'gmail' | 'woodpecker'
      owner_id: string | null
      owner_name: string | null
      settings: SequenceSettings
      step_count: number
      stats: SequenceStats
    }>(sql`
      select s.id, s.name, s.description, s.state, s.sender, s.owner_id, u.name as owner_name,
             s.settings,
             (select count(*) from sequence_step st where st.sequence_id = s.id)::int as step_count,
             ${statsSql} as stats
        from sequence s
        left join user_account u on u.id = s.owner_id
       order by s.state, lower(s.name)
    `)
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      state: row.state,
      sender: row.sender,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      settings: row.settings,
      stepCount: Number(row.step_count),
      stats: { ...emptyStats(), ...row.stats },
    }))
  })

/** How each subject of a step actually did. Only for a step that is testing two;
 *  a step with one subject has nothing to compare. */
export type VariantResult = { stepId: string; variant: string; sent: number; opened: number; replied: number }

export const readSequence = async (
  ctx: AccountContext,
  id: string,
): Promise<{ sequence: SequenceRow; steps: SequenceStep[]; variants: VariantResult[] } | null> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx.execute<{
      id: string
      name: string
      description: string | null
      state: SequenceState
      sender: 'gmail' | 'woodpecker'
      owner_id: string | null
      owner_name: string | null
      settings: SequenceSettings
      step_count: number
      stats: SequenceStats
    }>(sql`
      select s.id, s.name, s.description, s.state, s.sender, s.owner_id, u.name as owner_name,
             s.settings,
             (select count(*) from sequence_step st where st.sequence_id = s.id)::int as step_count,
             ${statsSql} as stats
        from sequence s
        left join user_account u on u.id = s.owner_id
       where s.id = ${id}
       limit 1
    `)
    const row = rows[0]
    if (!row) return null

    const steps = await tx
      .select({
        id: sequenceStep.id,
        position: sequenceStep.position,
        kind: sequenceStep.kind,
        delayDays: sequenceStep.delayDays,
        delayHours: sequenceStep.delayHours,
        subject: sequenceStep.subject,
        subjectB: sequenceStep.subjectB,
        bodyHtml: sequenceStep.bodyHtml,
        bodyText: sequenceStep.bodyText,
        taskTitle: sequenceStep.taskTitle,
        taskBody: sequenceStep.taskBody,
      })
      .from(sequenceStep)
      .where(eq(sequenceStep.sequenceId, id))
      .orderBy(asc(sequenceStep.position))

    // One grouped pass over this sequence's sends, not one query per step. A
    // reply counts against the send that provoked it: the enrollment stopped as
    // replied, and this is the last thing it had sent.
    const variants = await tx.execute<{
      step_id: string
      variant: string
      sent: number
      opened: number
      replied: number
    }>(sql`
      select d.step_id, d.variant,
             count(*)::int as sent,
             count(*) filter (where d.open_count > 0)::int as opened,
             count(*) filter (where e.state = 'replied')::int as replied
        from sequence_send d
        join sequence_enrollment e on e.id = d.enrollment_id
       where e.sequence_id = ${id} and d.variant is not null
       group by d.step_id, d.variant`)

    return {
      sequence: {
        id: row.id,
        name: row.name,
        description: row.description,
        state: row.state,
        sender: row.sender,
        ownerId: row.owner_id,
        ownerName: row.owner_name,
        settings: row.settings,
        stepCount: Number(row.step_count),
        stats: { ...emptyStats(), ...row.stats },
      },
      steps,
      variants: variants.map((each) => ({
        stepId: each.step_id,
        variant: each.variant,
        sent: Number(each.sent),
        opened: Number(each.opened),
        replied: Number(each.replied),
      })),
    }
  })

export const saveSequence = async (
  ctx: AccountContext,
  input: {
    id?: string | null | undefined
    name: string
    description?: string | null | undefined
    sender?: 'gmail' | 'woodpecker' | undefined
    settings?: Partial<{
      sendWindow: SendWindow | undefined
      stopOnReply: boolean | undefined
      stopOnBounce: boolean | undefined
      stopOnUnsubscribe: boolean | undefined
      trackOpens: boolean | undefined
      trackClicks: boolean | undefined
      subscriptionTypeId: string | null | undefined
      replyInThread: boolean | undefined
      woodpeckerCampaignId: number | null | undefined
    }> | undefined
  },
): Promise<{ id: string }> =>
  mutate(ctx, 'sequence', async (tx) => {
    const name = input.name.trim()
    if (name === '') throw new Error('A sequence needs a name.')

    if (input.id) {
      const [before] = await tx.select().from(sequence).where(eq(sequence.id, input.id))
      if (!before) throw new Error('That sequence is not in this account.')
      // A partial patch: an absent key keeps what was there, rather than
      // overwriting it with undefined, which is what a plain spread would do.
      const settings = mergeSettings(before.settings, input.settings)
      assertWindow(settings.sendWindow)
      await tx
        .update(sequence)
        .set({
          name,
          description: input.description ?? null,
          ...(input.sender ? { sender: input.sender } : {}),
          settings,
          updatedAt: new Date(),
        })
        .where(eq(sequence.id, input.id))
      await resnapWaiting(tx, input.id, before.settings.sendWindow, settings.sendWindow)
      return {
        result: { id: input.id },
        audit: { entity: 'sequence', entityId: input.id, action: 'update', before, after: { name, settings } },
      }
    }

    const settings = mergeSettings(DEFAULT_SEQUENCE_SETTINGS, input.settings)
    assertWindow(settings.sendWindow)
    const [row] = await tx
      .insert(sequence)
      .values({
        accountId: ctx.accountId,
        name,
        description: input.description ?? null,
        sender: input.sender ?? 'gmail',
        settings,
        ownerId: ctx.actorId,
        createdBy: ctx.actorId,
      })
      .onConflictDoNothing()
      .returning({ id: sequence.id })
    if (!row) throw new Error(`This account already has a sequence called "${name}".`)
    return {
      result: { id: row.id },
      audit: { entity: 'sequence', entityId: row.id, action: 'create', after: { name } },
    }
  })

/** A waiting enrollment holds a time worked out against the window in force when
 *  it was scheduled, so changing the window has to move it. Widening it and
 *  leaving everybody already enrolled waiting for Monday, while anybody enrolled a
 *  minute later goes out at once, is two schedules in one sequence. Narrowing it
 *  and leaving them is a send outside the window that forbids it.
 *
 *  Worked out from when the step actually became due -- the previous send, or the
 *  enrolment for the first step, plus that step's own wait -- rather than from the
 *  time currently stored. The stored time is an answer to the old window and says
 *  nothing about the question. Reading it as the question is how a two-day wait
 *  between steps gets thrown away by an unrelated change to Saturdays.
 *
 *  Rows only, no lease: an enrollment a worker is holding is left alone and picks
 *  up the new window on its next step. */
const resnapWaiting = async (
  tx: Tx,
  sequenceId: string,
  before: SendWindow,
  after: SendWindow,
): Promise<void> => {
  if (JSON.stringify(before) === JSON.stringify(after)) return

  const rows = await tx.execute<{
    id: string
    next_run_at: Date
    since: Date
    delay_days: number
    delay_hours: number
  }>(sql`
    select e.id, e.next_run_at,
           coalesce(e.last_sent_at, e.created_at) as since,
           coalesce(s.delay_days, 0) as delay_days,
           coalesce(s.delay_hours, 0) as delay_hours
      from sequence_enrollment e
      left join sequence_step s
        on s.sequence_id = e.sequence_id and s.position = e.current_step
     where e.sequence_id = ${sequenceId}
       and e.state = 'active'
       and e.lease_until is null
       and e.next_run_at is not null`)

  for (const row of rows) {
    const next = nextSendAt({
      after: new Date(row.since),
      delayDays: Number(row.delay_days),
      delayHours: Number(row.delay_hours),
      window: after,
    })
    if (next.getTime() === new Date(row.next_run_at).getTime()) continue
    await tx.update(sequenceEnrollment).set({ nextRunAt: next }).where(eq(sequenceEnrollment.id, row.id))
  }
}

type SettingsPatch = {
  [K in keyof SequenceSettings]?: SequenceSettings[K] | undefined
}

const mergeSettings = (base: SequenceSettings, patch: SettingsPatch | undefined): SequenceSettings => {
  const merged = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value
  }
  return merged
}

const assertWindow = (window: SendWindow): void => {
  if (window.days.length === 0) {
    throw new Error('A sending window needs at least one day, or nothing would ever go out.')
  }
  if (window.start >= window.end) {
    throw new Error('The sending window has to end after it starts.')
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: window.timezone })
  } catch {
    throw new Error(`"${window.timezone}" is not a timezone this system knows.`)
  }
}

export const setSequenceState = async (
  ctx: AccountContext,
  input: { id: string; state: SequenceState },
): Promise<void> =>
  mutate(ctx, 'sequence', async (tx) => {
    const [before] = await tx
      .select({ state: sequence.state, name: sequence.name })
      .from(sequence)
      .where(eq(sequence.id, input.id))
    if (!before) throw new Error('That sequence is not in this account.')

    if (input.state === 'active') {
      const [steps] = await tx.execute<{ n: number; emails: number }>(sql`
        select count(*)::int as n,
               count(*) filter (where kind = 'email' and coalesce(subject, '') <> '')::int as emails
          from sequence_step where sequence_id = ${input.id}`)
      if (Number(steps?.n ?? 0) === 0) throw new Error('Add a step before turning this on.')
      if (Number(steps?.emails ?? 0) === 0) {
        throw new Error('At least one step has to be an email with a subject, or nothing is ever sent.')
      }
    }

    await tx.update(sequence).set({ state: input.state, updatedAt: new Date() }).where(eq(sequence.id, input.id))

    // Pausing the sequence pauses what is in flight; resuming puts them back on
    // the queue where they were rather than starting anybody over.
    if (input.state === 'paused') {
      await tx
        .update(sequenceEnrollment)
        .set({ state: 'paused' })
        .where(and(eq(sequenceEnrollment.sequenceId, input.id), eq(sequenceEnrollment.state, 'active')))
    }
    if (input.state === 'active' && before.state === 'paused') {
      await tx
        .update(sequenceEnrollment)
        .set({ state: 'active' })
        .where(and(eq(sequenceEnrollment.sequenceId, input.id), eq(sequenceEnrollment.state, 'paused')))
    }

    return {
      result: undefined,
      audit: {
        entity: 'sequence',
        entityId: input.id,
        action: 'set_state',
        before: { state: before.state },
        after: { state: input.state },
      },
    }
  })

export const saveSteps = async (
  ctx: AccountContext,
  input: {
    sequenceId: string
    steps: {
      id?: string | null | undefined
      kind: StepKind
      delayDays: number
      delayHours: number
      subject?: string | null | undefined
      subjectB?: string | null | undefined
      bodyHtml?: string | null | undefined
      bodyText?: string | null | undefined
      taskTitle?: string | null | undefined
      taskBody?: string | null | undefined
    }[]
  },
): Promise<void> =>
  mutate(ctx, 'sequence_step', async (tx) => {
    const [exists] = await tx.select({ id: sequence.id }).from(sequence).where(eq(sequence.id, input.sequenceId))
    if (!exists) throw new Error('That sequence is not in this account.')

    const keep = input.steps.map((step) => step.id).filter((id): id is string => Boolean(id))
    const [dropped] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n
        from sequence_step st
       where st.sequence_id = ${input.sequenceId}
         ${keep.length > 0 ? sql`and st.id not in (${sql.join(keep.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``}
         and exists (select 1 from sequence_send d where d.step_id = st.id)`)
    if (Number(dropped?.n ?? 0) > 0) {
      throw new Error(
        'A step that has already been sent cannot be removed; the mail it sent would lose what it belonged to. Turn the sequence off instead.',
      )
    }

    await tx.execute(
      keep.length > 0
        ? sql`delete from sequence_step where sequence_id = ${input.sequenceId}
              and id not in (${sql.join(keep.map((id) => sql`${id}::uuid`), sql`, `)})`
        : sql`delete from sequence_step where sequence_id = ${input.sequenceId}`,
    )

    for (const [index, step] of input.steps.entries()) {
      if (step.kind === 'email' && !(step.subject ?? '').trim()) {
        throw new Error(`Step ${index + 1} is an email and needs a subject.`)
      }
      if (step.kind !== 'email' && !(step.taskTitle ?? '').trim()) {
        throw new Error(`Step ${index + 1} makes a task and needs a title for it.`)
      }
      const values = {
        accountId: ctx.accountId,
        sequenceId: input.sequenceId,
        position: index,
        kind: step.kind,
        delayDays: Math.max(0, step.delayDays),
        delayHours: Math.max(0, step.delayHours),
        subject: step.subject ?? null,
        // An empty second line means no test, not a test against nothing.
        subjectB: (step.subjectB ?? '').trim() || null,
        bodyHtml: step.bodyHtml ?? null,
        bodyText: step.bodyText ?? null,
        taskTitle: step.taskTitle ?? null,
        taskBody: step.taskBody ?? null,
      }
      if (step.id) await tx.update(sequenceStep).set(values).where(eq(sequenceStep.id, step.id))
      else await tx.insert(sequenceStep).values(values)
    }

    return {
      result: undefined,
      audit: {
        entity: 'sequence_step',
        entityId: input.sequenceId,
        action: 'save_steps',
        after: { count: input.steps.length },
      },
    }
  })

// ---------------------------------------------------------------- enrolment

export type EnrollOutcome = { contactId: string; enrolled: boolean; reason?: string }

/** Puts contacts into a sequence, and says per contact why any of them did not go
 *  in. A silent partial success is how somebody discovers three months later that
 *  half the list was never contacted. */
export const enroll = async (
  ctx: AccountContext,
  input: { sequenceId: string; contactIds?: string[] | undefined; companyId?: string | null | undefined; mailboxId: string },
): Promise<EnrollOutcome[]> =>
  mutate(ctx, 'sequence_enrollment', async (tx) => {
    const [found] = await tx
      .select({ id: sequence.id, name: sequence.name, state: sequence.state, settings: sequence.settings, sender: sequence.sender })
      .from(sequence)
      .where(eq(sequence.id, input.sequenceId))
    if (!found) throw new Error('That sequence is not in this account.')
    if (found.state === 'archived') throw new Error('That sequence is archived. Copy it to use it again.')

    // Everyone at a company, resolved here rather than in the browser: a company
    // with four hundred contacts should not send four hundred ids over the wire,
    // and who is at a company is not the client's decision to make.
    const contactIds = input.companyId
      ? (
          await tx.execute<{ id: string }>(sql`
            select id from contact
             where company_id = ${input.companyId}::uuid
               and deleted_at is null
               and coalesce(email, '') <> ''
             order by created_at`)
        ).map((row) => row.id)
      : (input.contactIds ?? [])
    if (contactIds.length === 0) {
      throw new Error(
        input.companyId
          ? 'Nobody at that company has an email address to write to.'
          : 'Nobody was named to enrol.',
      )
    }

    const [box] = await tx
      .select({ id: mailbox.id, state: mailbox.state, canSend: mailbox.canSend, email: mailbox.email })
      .from(mailbox)
      .where(eq(mailbox.id, input.mailboxId))
    if (!box) throw new Error('That mailbox is not connected.')
    // A Woodpecker sequence never sends from this mailbox: the campaign there has
    // its own sending accounts, and the mailbox only names who owns the outreach.
    // So the grant to send is asked for only when Rawr is the one sending.
    if (found.sender === 'gmail') {
      if (box.state === 'revoked') throw new Error(`${box.email} is disconnected. Reconnect it before enrolling anybody.`)
      if (!box.canSend) {
        throw new Error(`${box.email} was connected for reading only. Reconnect it and allow sending.`)
      }
    }

    const ids = [...new Set(contactIds)]
    if (ids.length === 0) return { result: [], audit: { entity: 'sequence_enrollment', entityId: input.sequenceId, action: 'enroll', after: { count: 0 } } }

    const people = await tx
      .select({ id: contact.id, email: contact.email })
      .from(contact)
      .where(inArray(contact.id, ids))

    // Everything that would refuse a contact, asked once for the whole batch
    // rather than once per contact: three statements, not three times N.
    const optedOut = new Set(
      found.settings.subscriptionTypeId
        ? (
            await tx.execute<{ contact_id: string }>(sql`
              select contact_id from subscription_state
               where subscription_type_id = ${found.settings.subscriptionTypeId}::uuid
                 and state = 'unsubscribed'
                 and contact_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)
          ).map((row) => row.contact_id)
        : [],
    )
    const alreadyIn = new Set(
      (
        await tx.execute<{ contact_id: string }>(sql`
          select contact_id from sequence_enrollment
           where sequence_id = ${input.sequenceId}
             and state in ('active', 'waiting_task', 'paused')
             and contact_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`)
      ).map((row) => row.contact_id),
    )

    const window = found.settings.sendWindow
    const outcomes: EnrollOutcome[] = []

    for (const id of ids) {
      const person = people.find((row) => row.id === id)
      if (!person) {
        outcomes.push({ contactId: id, enrolled: false, reason: 'That contact is not in this account.' })
        continue
      }
      if (!person.email) {
        outcomes.push({ contactId: id, enrolled: false, reason: 'No email address.' })
        continue
      }
      if (optedOut.has(id)) {
        outcomes.push({ contactId: id, enrolled: false, reason: 'They have opted out of this kind of mail.' })
        continue
      }
      if (alreadyIn.has(id)) {
        outcomes.push({ contactId: id, enrolled: false, reason: 'Already in this sequence.' })
        continue
      }

      const [created] = await tx
        .insert(sequenceEnrollment)
        .values({
          accountId: ctx.accountId,
          sequenceId: input.sequenceId,
          contactId: id,
          mailboxId: input.mailboxId,
          enrolledBy: ctx.actorId,
          state: found.state === 'active' ? 'active' : 'paused',
          nextRunAt: nextSendAt({ after: new Date(), delayDays: 0, delayHours: 0, window }),
          unsubscribeToken: randomToken(24),
        })
        .onConflictDoNothing()
        .returning({ id: sequenceEnrollment.id })
      if (!created) {
        outcomes.push({ contactId: id, enrolled: false, reason: 'Already in this sequence.' })
        continue
      }

      await tx.insert(sequenceEvent).values({
        accountId: ctx.accountId,
        enrollmentId: created.id,
        kind: 'sent',
        detail: { event: 'enrolled' },
      })
      await recordActivity(tx, ctx, {
        type: 'sequence_activity',
        subject: `was enrolled in ${found.name}`,
        payload: { event: 'enrolled', sequenceId: input.sequenceId, sequenceName: found.name, enrollmentId: created.id, contactName: await contactLabels(tx, [id]) },
        links: await linksForContacts(tx, [id]),
      })
      outcomes.push({ contactId: id, enrolled: true })
    }

    return {
      result: outcomes,
      audit: {
        entity: 'sequence_enrollment',
        entityId: input.sequenceId,
        action: 'enroll',
        after: { enrolled: outcomes.filter((row) => row.enrolled).length, refused: outcomes.filter((row) => !row.enrolled).length },
      },
    }
  })

export type EnrollmentRow = {
  id: string
  contactId: string
  contactName: string
  contactEmail: string | null
  state: EnrollmentState
  currentStep: number
  nextRunAt: Date | null
  lastSentAt: Date | null
  stopReason: string | null
  sends: number
  opens: number
  clicks: number
}

export const listEnrollments = async (
  ctx: AccountContext,
  input: { sequenceId: string; state?: EnrollmentState | null | undefined; limit?: number | undefined },
): Promise<EnrollmentRow[]> =>
  withAccount(ctx, async (tx) => {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500)
    const rows = await tx.execute<{
      id: string
      contact_id: string
      contact_name: string
      contact_email: string | null
      state: EnrollmentState
      current_step: number
      next_run_at: Date | null
      last_sent_at: Date | null
      stop_reason: string | null
      sends: number
      opens: number
      clicks: number
    }>(sql`
      select e.id, e.contact_id,
             coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.email, 'Unnamed') as contact_name,
             c.email as contact_email,
             e.state, e.current_step, e.next_run_at, e.last_sent_at, e.stop_reason,
             (select count(*) from sequence_send d where d.enrollment_id = e.id)::int as sends,
             (select count(*) from sequence_send d where d.enrollment_id = e.id and d.open_count > 0)::int as opens,
             (select count(*) from sequence_send d where d.enrollment_id = e.id and d.click_count > 0)::int as clicks
        from sequence_enrollment e
        join contact c on c.id = e.contact_id
       where e.sequence_id = ${input.sequenceId}
         and (${input.state ?? null}::text is null or e.state::text = ${input.state ?? null})
       order by e.state, e.next_run_at nulls last, e.created_at desc
       limit ${limit}
    `)
    return rows.map((row) => ({
      id: row.id,
      contactId: row.contact_id,
      contactName: row.contact_name,
      contactEmail: row.contact_email,
      state: row.state,
      currentStep: Number(row.current_step),
      nextRunAt: row.next_run_at ? new Date(row.next_run_at) : null,
      lastSentAt: row.last_sent_at ? new Date(row.last_sent_at) : null,
      stopReason: row.stop_reason,
      sends: Number(row.sends),
      opens: Number(row.opens),
      clicks: Number(row.clicks),
    }))
  })

/** Somebody's own enrollments, for the record page. */
export type ContactEnrollment = {
  id: string
  sequenceId: string
  sequenceName: string
  sequenceState: SequenceState
  state: EnrollmentState
  currentStep: number
  stepCount: number
  nextRunAt: Date | null
  lastSentAt: Date | null
  stopReason: string | null
  enrolledAt: Date
}

export const enrollmentsForContact = async (
  ctx: AccountContext,
  contactId: string,
): Promise<ContactEnrollment[]> =>
  withAccount(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: sequenceEnrollment.id,
        sequenceId: sequence.id,
        sequenceName: sequence.name,
        sequenceState: sequence.state,
        state: sequenceEnrollment.state,
        currentStep: sequenceEnrollment.currentStep,
        stepCount: sql<number>`(select count(*)::int from sequence_step st where st.sequence_id = ${sequence.id})`,
        nextRunAt: sequenceEnrollment.nextRunAt,
        lastSentAt: sequenceEnrollment.lastSentAt,
        stopReason: sequenceEnrollment.stopReason,
        enrolledAt: sequenceEnrollment.createdAt,
      })
      .from(sequenceEnrollment)
      .innerJoin(sequence, eq(sequence.id, sequenceEnrollment.sequenceId))
      .where(eq(sequenceEnrollment.contactId, contactId))
      .orderBy(desc(sequenceEnrollment.createdAt))
      .limit(20)
    return rows
  })

const setEnrollmentState = async (
  ctx: AccountContext,
  id: string,
  state: EnrollmentState,
  reason: string | null,
): Promise<void> =>
  mutate(ctx, 'sequence_enrollment', async (tx) => {
    const [before] = await tx
      .select({ state: sequenceEnrollment.state, contactId: sequenceEnrollment.contactId })
      .from(sequenceEnrollment)
      .where(eq(sequenceEnrollment.id, id))
    if (!before) throw new Error('That enrollment no longer exists.')

    // Finer than the role matrix: pausing somebody else's outreach is an admin's
    // or the enroller's decision, not anybody with write access.
    await tx
      .update(sequenceEnrollment)
      .set({
        state,
        stopReason: reason,
        nextRunAt: STOPPED.includes(state) ? null : sequenceEnrollment.nextRunAt,
        finishedAt: STOPPED.includes(state) ? new Date() : null,
        leaseUntil: null,
      })
      .where(eq(sequenceEnrollment.id, id))

    if (STOPPED.includes(state)) {
      await tx.insert(sequenceEvent).values({
        accountId: ctx.accountId,
        enrollmentId: id,
        kind: 'stopped',
        detail: { state, reason },
      })
    }

    return {
      result: undefined,
      audit: {
        entity: 'sequence_enrollment',
        entityId: id,
        action: 'set_state',
        before: { state: before.state },
        after: { state, reason },
      },
    }
  })

export const pauseEnrollment = (ctx: AccountContext, id: string): Promise<void> =>
  setEnrollmentState(ctx, id, 'paused', null)

export const resumeEnrollment = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'sequence_enrollment', async (tx) => {
    const [row] = await tx
      .select({ state: sequenceEnrollment.state, sequenceId: sequenceEnrollment.sequenceId })
      .from(sequenceEnrollment)
      .where(eq(sequenceEnrollment.id, id))
    if (!row) throw new Error('That enrollment no longer exists.')
    if (row.state !== 'paused') throw new Error('That enrollment is not paused.')

    const [seq] = await tx.select({ settings: sequence.settings }).from(sequence).where(eq(sequence.id, row.sequenceId))
    await tx
      .update(sequenceEnrollment)
      .set({
        state: 'active',
        nextRunAt: nextSendAt({
          after: new Date(),
          delayDays: 0,
          delayHours: 0,
          window: seq?.settings.sendWindow ?? DEFAULT_WINDOW,
        }),
      })
      .where(eq(sequenceEnrollment.id, id))
    return { result: undefined, audit: { entity: 'sequence_enrollment', entityId: id, action: 'resume' } }
  })

export const removeEnrollment = (ctx: AccountContext, id: string, reason = 'Removed by hand'): Promise<void> =>
  setEnrollmentState(ctx, id, 'removed', reason)

export const stopEnrollment = (
  ctx: AccountContext,
  id: string,
  state: 'replied' | 'bounced' | 'unsubscribed' | 'failed' | 'finished',
  reason: string,
): Promise<void> => setEnrollmentState(ctx, id, state, reason)

// ---------------------------------------------------------------- the queue

export type ClaimedRun = {
  enrollmentId: string
  sequenceId: string
  sequenceName: string
  sender: 'gmail' | 'woodpecker'
  settings: SequenceSettings
  contactId: string
  contactEmail: string
  contactFirstName: string | null
  contactLastName: string | null
  companyName: string | null
  mailboxId: string
  mailboxEmail: string
  mailboxCanSend: boolean
  mailboxDailyCap: number
  mailboxMinGapSeconds: number
  mailboxWindow: SendWindow | null
  currentStep: number
  threadId: string | null
  /** Gmail's own id for the conversation, which is what its send endpoint wants. */
  providerThreadId: string | null
  rootInternetMessageId: string | null
  unsubscribeToken: string
  lastSentAt: Date | null
  step: SequenceStep | null
  /** How many this mailbox has already sent in the window's day. */
  sentToday: number
  trackingDomain: string | null
}

/** How long a claim is held. Long enough for a slow Gmail call and a token
 *  refresh, short enough that a worker killed mid-send frees the enrollment
 *  before the recipient notices anything. */
const LEASE_MINUTES = 10

/** Takes the enrollment, or returns null because somebody else has it.
 *
 *  `for update skip locked` is what makes two workers safe: the second one steps
 *  over the row rather than waiting for it, so a slow send never blocks the queue.
 *  The lease is the second guard, for the worker that dies holding the row. */
export const claimEnrollmentRun = async (
  ctx: AccountContext,
  enrollmentId: string,
): Promise<ClaimedRun | null> =>
  withAccount(ctx, async (tx) => {
    const claimed = await tx.execute<{ id: string }>(sql`
      update sequence_enrollment
         set lease_until = now() + ${`${LEASE_MINUTES} minutes`}::interval
       where id = (
         select id from sequence_enrollment
          where id = ${enrollmentId}::uuid
            and state = 'active'
            and next_run_at is not null
            and next_run_at <= now()
            and (lease_until is null or lease_until < now())
          for update skip locked
       )
      returning id
    `)
    if (claimed.length === 0) return null

    const rows = await tx.execute<{
      enrollment_id: string
      sequence_id: string
      sequence_name: string
      sender: 'gmail' | 'woodpecker'
      settings: SequenceSettings
      contact_id: string
      contact_email: string | null
      first_name: string | null
      last_name: string | null
      company_name: string | null
      mailbox_id: string | null
      mailbox_email: string | null
      can_send: boolean | null
      daily_cap: number | null
      min_gap_seconds: number | null
      mailbox_window: SendWindow | null
      current_step: number
      thread_id: string | null
      provider_thread_id: string | null
      root_internet_message_id: string | null
      unsubscribe_token: string
      last_sent_at: Date | null
      sent_today: number
      tracking_domain: string | null
    }>(sql`
      select e.id as enrollment_id, s.id as sequence_id, s.name as sequence_name, s.sender, s.settings,
             c.id as contact_id, c.email as contact_email, c.first_name, c.last_name,
             co.name as company_name,
             m.id as mailbox_id, m.email as mailbox_email, m.can_send, m.daily_cap,
             m.min_gap_seconds, m.send_window as mailbox_window,
             e.current_step, e.thread_id, t.provider_thread_id,
             e.root_internet_message_id, e.unsubscribe_token, e.last_sent_at,
             (select count(*) from sequence_send d
               where d.mailbox_id = m.id and d.sent_at >= date_trunc('day', now()))::int as sent_today,
             (select a.tracking_domain from account a limit 1) as tracking_domain
        from sequence_enrollment e
        join sequence s on s.id = e.sequence_id
        join contact c on c.id = e.contact_id
        left join company co on co.id = c.company_id
        left join mailbox m on m.id = e.mailbox_id
        left join message_thread t on t.id = e.thread_id
       where e.id = ${enrollmentId}::uuid
    `)
    const row = rows[0]
    if (!row || !row.contact_email || !row.mailbox_id || !row.mailbox_email) return null

    const [step] = await tx
      .select({
        id: sequenceStep.id,
        position: sequenceStep.position,
        kind: sequenceStep.kind,
        delayDays: sequenceStep.delayDays,
        delayHours: sequenceStep.delayHours,
        subject: sequenceStep.subject,
        subjectB: sequenceStep.subjectB,
        bodyHtml: sequenceStep.bodyHtml,
        bodyText: sequenceStep.bodyText,
        taskTitle: sequenceStep.taskTitle,
        taskBody: sequenceStep.taskBody,
      })
      .from(sequenceStep)
      .where(and(eq(sequenceStep.sequenceId, row.sequence_id), eq(sequenceStep.position, row.current_step)))

    return {
      enrollmentId: row.enrollment_id,
      sequenceId: row.sequence_id,
      sequenceName: row.sequence_name,
      sender: row.sender,
      settings: row.settings,
      contactId: row.contact_id,
      contactEmail: row.contact_email,
      contactFirstName: row.first_name,
      contactLastName: row.last_name,
      companyName: row.company_name,
      mailboxId: row.mailbox_id,
      mailboxEmail: row.mailbox_email,
      mailboxCanSend: row.can_send ?? false,
      mailboxDailyCap: Number(row.daily_cap ?? 100),
      mailboxMinGapSeconds: Number(row.min_gap_seconds ?? 45),
      mailboxWindow: row.mailbox_window,
      currentStep: Number(row.current_step),
      threadId: row.thread_id,
      providerThreadId: row.provider_thread_id,
      rootInternetMessageId: row.root_internet_message_id,
      unsubscribeToken: row.unsubscribe_token,
      lastSentAt: row.last_sent_at ? new Date(row.last_sent_at) : null,
      step: step ?? null,
      sentToday: Number(row.sent_today),
      trackingDomain: row.tracking_domain,
    }
  })

/** Puts a claimed enrollment back without advancing it: the window is shut, the
 *  cap is reached, or the gap has not passed. */
export const deferRun = async (ctx: AccountContext, enrollmentId: string, until: Date): Promise<void> =>
  withAccount(ctx, async (tx) => {
    await tx
      .update(sequenceEnrollment)
      .set({ nextRunAt: until, leaseUntil: null })
      .where(eq(sequenceEnrollment.id, enrollmentId))
  })

export type RecordedSend = { sendId: string; token: string }

/** One sent step: the row that the pixel, the click and the reply all point back
 *  to, and the advance to the next step in the same transaction, so a crash
 *  between the two cannot send the same mail twice. */
export const recordSend = async (
  ctx: AccountContext,
  input: {
    enrollmentId: string
    stepId: string
    mailboxId: string
    providerMessageId: string | null
    internetMessageId: string | null
    /** Which subject went out, when the step was testing two. */
    variant?: string | null | undefined
    threadId?: string | null
    /** The stored copy and its timeline row, from the ingest that ran first. The
     *  card reads opens and clicks through the send row this joins to it. */
    messageId?: string | null
    activityId?: string | null
    token: string
    links: { token: string; url: string }[]
    subject: string
    contactId: string
  },
): Promise<RecordedSend> =>
  mutate(ctx, 'sequence_enrollment', async (tx) => {
    const [send] = await tx
      .insert(sequenceSend)
      .values({
        accountId: ctx.accountId,
        enrollmentId: input.enrollmentId,
        stepId: input.stepId,
        mailboxId: input.mailboxId,
        providerMessageId: input.providerMessageId,
        internetMessageId: input.internetMessageId,
        variant: input.variant ?? null,
        messageId: input.messageId ?? null,
        token: input.token,
      })
      .returning({ id: sequenceSend.id })
    if (!send) throw new Error('The send could not be recorded.')

    if (input.links.length > 0) {
      await tx.insert(sequenceLink).values(
        input.links.map((link) => ({
          accountId: ctx.accountId,
          sendId: send.id,
          token: link.token,
          url: link.url,
        })),
      )
    }

    await tx.insert(sequenceEvent).values({
      accountId: ctx.accountId,
      enrollmentId: input.enrollmentId,
      sendId: send.id,
      kind: 'sent',
      detail: { subject: input.subject },
    })

    if (input.activityId) {
      await tx.execute(sql`
        update activity set payload = coalesce(payload, '{}'::jsonb) || ${JSON.stringify({ sendId: send.id })}::jsonb
         where id = ${input.activityId}::uuid`)
    }

    await advance(tx, ctx, input.enrollmentId, {
      threadId: input.threadId ?? null,
      internetMessageId: input.internetMessageId,
    })

    return {
      result: { sendId: send.id, token: input.token },
      audit: { entity: 'sequence_send', entityId: send.id, action: 'send', after: { subject: input.subject } },
    }
  })

/** Moves to the next step, or finishes. Called inside the same transaction as the
 *  send it follows. */
const advance = async (
  tx: Tx,
  ctx: AccountContext,
  enrollmentId: string,
  thread: { threadId: string | null; internetMessageId: string | null },
): Promise<void> => {
  const [row] = await tx
    .select({
      sequenceId: sequenceEnrollment.sequenceId,
      contactId: sequenceEnrollment.contactId,
      currentStep: sequenceEnrollment.currentStep,
      rootId: sequenceEnrollment.rootInternetMessageId,
      threadId: sequenceEnrollment.threadId,
    })
    .from(sequenceEnrollment)
    .where(eq(sequenceEnrollment.id, enrollmentId))
  if (!row) return

  const [seq] = await tx.select({ name: sequence.name, settings: sequence.settings }).from(sequence).where(eq(sequence.id, row.sequenceId))
  const next = row.currentStep + 1
  const [following] = await tx
    .select({ delayDays: sequenceStep.delayDays, delayHours: sequenceStep.delayHours })
    .from(sequenceStep)
    .where(and(eq(sequenceStep.sequenceId, row.sequenceId), eq(sequenceStep.position, next)))

  await tx
    .update(sequenceEnrollment)
    .set({
      currentStep: next,
      lastSentAt: new Date(),
      leaseUntil: null,
      // The first send owns the conversation every later step replies into.
      threadId: row.threadId ?? thread.threadId,
      rootInternetMessageId: row.rootId ?? thread.internetMessageId,
      ...(following
        ? {
            nextRunAt: nextSendAt({
              after: new Date(),
              delayDays: following.delayDays,
              delayHours: following.delayHours,
              window: seq?.settings.sendWindow ?? DEFAULT_WINDOW,
            }),
          }
        : { state: 'finished' as const, nextRunAt: null, finishedAt: new Date(), stopReason: 'Every step has run.' }),
    })
    .where(eq(sequenceEnrollment.id, enrollmentId))

  if (!following) {
    await recordActivity(tx, ctx, {
      type: 'sequence_activity',
      subject: `finished ${seq?.name ?? 'a sequence'}: every step ran with no reply`,
      payload: { event: 'finished', sequenceId: row.sequenceId, sequenceName: seq?.name ?? null, enrollmentId, contactName: await contactLabels(tx, [row.contactId]) },
      links: await linksForContacts(tx, [row.contactId]),
    })
  }
}

export const recordSendFailure = async (
  ctx: AccountContext,
  input: { enrollmentId: string; stepId: string | null; mailboxId: string; error: string },
): Promise<void> =>
  mutate(ctx, 'sequence_enrollment', async (tx) => {
    await tx.insert(sequenceSend).values({
      accountId: ctx.accountId,
      enrollmentId: input.enrollmentId,
      stepId: input.stepId,
      mailboxId: input.mailboxId,
      token: randomToken(18),
      state: 'failed',
      error: input.error.slice(0, 500),
    })
    await tx
      .update(sequenceEnrollment)
      .set({
        state: 'failed',
        stopReason: input.error.slice(0, 500),
        nextRunAt: null,
        finishedAt: new Date(),
        leaseUntil: null,
      })
      .where(eq(sequenceEnrollment.id, input.enrollmentId))
    return {
      result: undefined,
      audit: { entity: 'sequence_enrollment', entityId: input.enrollmentId, action: 'send_failed', after: { error: input.error } },
    }
  })

/** A non-email step: the work goes on somebody's task list and the enrollment
 *  waits there rather than running past it. */
export const createStepTask = async (
  ctx: AccountContext,
  input: { enrollmentId: string; contactId: string; title: string; body: string | null; assigneeId: string | null },
): Promise<{ taskId: string }> => {
  const created = await createTask(ctx, {
    title: input.title,
    body: input.body,
    assigneeId: input.assigneeId,
    entity: { entityType: 'contact', entityId: input.contactId },
  })

  await mutate(ctx, 'sequence_enrollment', async (tx) => {
    await tx
      .update(sequenceEnrollment)
      .set({ state: 'waiting_task', waitingTaskId: created.id, nextRunAt: null, leaseUntil: null })
      .where(eq(sequenceEnrollment.id, input.enrollmentId))
    await tx.insert(sequenceEvent).values({
      accountId: ctx.accountId,
      enrollmentId: input.enrollmentId,
      kind: 'task_created',
      detail: { taskId: created.id, title: input.title },
    })
    return {
      result: undefined,
      audit: { entity: 'sequence_enrollment', entityId: input.enrollmentId, action: 'wait_for_task', after: { taskId: created.id } },
    }
  })

  return { taskId: created.id }
}

/** Completing the task is what resumes the sequence. Called from `setTaskStatus`,
 *  so marking a call done in the task list moves the outreach on without anybody
 *  having to remember there is a sequence behind it. */
export const onTaskDone = async (tx: Tx, ctx: AccountContext, taskId: string): Promise<void> => {
  const [waiting] = await tx
    .select({ id: sequenceEnrollment.id, sequenceId: sequenceEnrollment.sequenceId, currentStep: sequenceEnrollment.currentStep })
    .from(sequenceEnrollment)
    .where(and(eq(sequenceEnrollment.waitingTaskId, taskId), eq(sequenceEnrollment.state, 'waiting_task')))
  if (!waiting) return

  const [seq] = await tx.select({ settings: sequence.settings }).from(sequence).where(eq(sequence.id, waiting.sequenceId))
  const next = waiting.currentStep + 1
  const [following] = await tx
    .select({ delayDays: sequenceStep.delayDays, delayHours: sequenceStep.delayHours })
    .from(sequenceStep)
    .where(and(eq(sequenceStep.sequenceId, waiting.sequenceId), eq(sequenceStep.position, next)))

  await tx
    .update(sequenceEnrollment)
    .set({
      currentStep: next,
      waitingTaskId: null,
      ...(following
        ? {
            state: 'active' as const,
            nextRunAt: nextSendAt({
              after: new Date(),
              delayDays: following.delayDays,
              delayHours: following.delayHours,
              window: seq?.settings.sendWindow ?? DEFAULT_WINDOW,
            }),
          }
        : { state: 'finished' as const, nextRunAt: null, finishedAt: new Date(), stopReason: 'Every step has run.' }),
    })
    .where(eq(sequenceEnrollment.id, waiting.id))

  await tx.insert(sequenceEvent).values({
    accountId: ctx.accountId,
    enrollmentId: waiting.id,
    kind: 'task_done',
    detail: { taskId },
  })
}

// -------------------------------------------------------- how it stops itself

/** Addresses that mean "this is a delivery report, not a person". */
const DAEMONS = /^(mailer-daemon|postmaster|no-?reply|bounce[s-]?)@/i

/** Headers an autoresponder sets. A holiday reply is not a reply, and treating it
 *  as one stops the sequence for somebody who never read it. */
export const isAutoReply = (headers: Record<string, string | undefined>): boolean => {
  const submitted = headers['auto-submitted']
  if (submitted && submitted.toLowerCase() !== 'no') return true
  if (headers['x-autoreply'] || headers['x-autorespond']) return true
  const precedence = headers.precedence?.toLowerCase()
  return precedence === 'auto_reply' || precedence === 'bulk'
}

export type InboundForDetection = {
  messageId: string
  contactIds: string[]
  fromAddr: string | null
  inReplyTo: string | null
  references: string[]
  threadId: string
  subject: string | null
  headers?: Record<string, string | undefined>
}

/** Called from `storeMessage` for every inbound message, so the sequence stops the
 *  moment the person answers, on the same sync that reads the answer.
 *
 *  Matched on the Message-ID a send actually set, falling back to the thread for
 *  rows stored before the headers were kept. Both are indexed, so this is two
 *  lookups whatever the mailbox holds. */
export const detectReply = async (
  tx: Tx,
  ctx: AccountContext,
  inbound: InboundForDetection,
): Promise<void> => {
  const from = inbound.fromAddr ?? ''
  const bounced = DAEMONS.test(from)
  if (!bounced && inbound.headers && isAutoReply(inbound.headers)) return

  const ids = [inbound.inReplyTo, ...inbound.references].filter((id): id is string => Boolean(id))

  const rows = await tx.execute<{ enrollment_id: string; send_id: string; sequence_id: string; sequence_name: string; stop_on_reply: boolean; stop_on_bounce: boolean }>(sql`
    select distinct e.id as enrollment_id, d.id as send_id, s.id as sequence_id, s.name as sequence_name,
           (s.settings ->> 'stopOnReply')::boolean as stop_on_reply,
           (s.settings ->> 'stopOnBounce')::boolean as stop_on_bounce
      from sequence_send d
      join sequence_enrollment e on e.id = d.enrollment_id
      join sequence s on s.id = e.sequence_id
     where e.state in ('active', 'waiting_task', 'paused')
       and (
         ${ids.length > 0
           ? sql`d.internet_message_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
           : sql`false`}
         or e.thread_id = ${inbound.threadId}::uuid
         ${inbound.contactIds.length > 0
           ? sql`or e.contact_id in (${sql.join(inbound.contactIds.map((id) => sql`${id}::uuid`), sql`, `)})`
           : sql``}
       )
  `)
  if (rows.length === 0) return

  for (const row of rows) {
    const stop = bounced ? row.stop_on_bounce : row.stop_on_reply
    const kind = bounced ? 'bounce' : 'reply'

    await tx.insert(sequenceEvent).values({
      accountId: ctx.accountId,
      enrollmentId: row.enrollment_id,
      sendId: row.send_id,
      kind,
      detail: { from, subject: inbound.subject, messageId: inbound.messageId },
    })

    if (bounced) {
      await tx.update(sequenceSend).set({ state: 'bounced' }).where(eq(sequenceSend.id, row.send_id))
    }

    if (stop) {
      await tx
        .update(sequenceEnrollment)
        .set({
          state: bounced ? 'bounced' : 'replied',
          stopReason: bounced ? `The mail bounced: ${from}` : `${from} replied.`,
          nextRunAt: null,
          finishedAt: new Date(),
          leaseUntil: null,
        })
        .where(eq(sequenceEnrollment.id, row.enrollment_id))
    }
  }

  // One row per sequence rather than per contact: a reply from a contact in two
  // sequences is two conversations that stopped.
  const names = new Map(rows.map((row) => [row.sequence_id, row.sequence_name]))
  const links = await linksForContacts(tx, inbound.contactIds)
  if (links.length === 0) return
  const contactName = await contactLabels(tx, inbound.contactIds)
  for (const [sequenceId, sequenceName] of names) {
    await recordActivity(tx, ctx, {
      type: 'sequence_activity',
      subject: bounced ? `did not receive ${sequenceName}: the mail bounced` : `replied, which stopped ${sequenceName}`,
      payload: { event: bounced ? 'bounced' : 'replied', sequenceId, sequenceName, contactName },
      links,
    })
  }
}

/** Somebody opting out through the app rather than through a mail. Called from
 *  `setSubscription`, so unsubscribing on the record stops the outreach too. */
export const onUnsubscribe = async (
  tx: Tx,
  ctx: AccountContext,
  input: { contactId: string; subscriptionTypeId: string },
): Promise<void> => {
  const rows = await tx.execute<{ id: string }>(sql`
    update sequence_enrollment e
       set state = 'unsubscribed',
           stop_reason = 'They opted out of this kind of mail.',
           next_run_at = null,
           finished_at = now(),
           lease_until = null
      from sequence s
     where s.id = e.sequence_id
       and e.contact_id = ${input.contactId}::uuid
       and e.state in ('active', 'waiting_task', 'paused')
       and (s.settings ->> 'stopOnUnsubscribe')::boolean
       and s.settings ->> 'subscriptionTypeId' = ${input.subscriptionTypeId}
    returning e.id`)

  for (const row of rows) {
    await tx.insert(sequenceEvent).values({
      accountId: ctx.accountId,
      enrollmentId: row.id,
      kind: 'unsubscribe',
      detail: { via: 'app' },
    })
  }
}

// ------------------------------------------------------------------ tracking

export type OpenMeta = { userAgent?: string | null | undefined; ip?: string | null | undefined }

/** A pixel fetch. Counted, never deduplicated: "opened four times" is a real
 *  signal, and the first open is the one that matters most, so it is kept
 *  separately. */
export const recordOpen = async (ctx: AccountContext, token: string, meta: OpenMeta = {}): Promise<boolean> =>
  withAccount(ctx, async (tx) => {
    const [send] = await tx
      .update(sequenceSend)
      .set({
        openCount: sql`${sequenceSend.openCount} + 1`,
        firstOpenedAt: sql`coalesce(${sequenceSend.firstOpenedAt}, now())`,
        lastOpenedAt: new Date(),
      })
      .where(eq(sequenceSend.token, token))
      .returning({ id: sequenceSend.id, enrollmentId: sequenceSend.enrollmentId })
    if (!send) return false

    await tx.insert(sequenceEvent).values({
      accountId: ctx.accountId,
      enrollmentId: send.enrollmentId,
      sendId: send.id,
      kind: 'open',
      // Apple Mail Privacy Protection fetches every pixel, so the agent is kept:
      // it is the only thing that tells a proxied open from a real one.
      detail: { userAgent: meta.userAgent ?? null },
    })
    return true
  })

/** A click. Returns the URL to redirect to, which is read from the row rather
 *  than taken from the request, so this endpoint is not an open redirect. */
export const recordClick = async (ctx: AccountContext, token: string, meta: OpenMeta = {}): Promise<string | null> =>
  withAccount(ctx, async (tx) => {
    const [link] = await tx
      .update(sequenceLink)
      .set({ clickCount: sql`${sequenceLink.clickCount} + 1` })
      .where(eq(sequenceLink.token, token))
      .returning({ id: sequenceLink.id, url: sequenceLink.url, sendId: sequenceLink.sendId })
    if (!link) return null

    const [send] = await tx
      .update(sequenceSend)
      .set({ clickCount: sql`${sequenceSend.clickCount} + 1` })
      .where(eq(sequenceSend.id, link.sendId))
      .returning({ id: sequenceSend.id, enrollmentId: sequenceSend.enrollmentId })

    if (send) {
      await tx.insert(sequenceEvent).values({
        accountId: ctx.accountId,
        enrollmentId: send.enrollmentId,
        sendId: send.id,
        kind: 'click',
        detail: { url: link.url, userAgent: meta.userAgent ?? null },
      })
    }
    return link.url
  })

export type UnsubscribeTarget = {
  enrollmentId: string
  accountId: string
  contactId: string
  contactEmail: string | null
  sequenceName: string
  subscriptionTypeId: string | null
}

/** Who an unsubscribe token belongs to. Read outside any scope, because the
 *  person clicking it has no session: the token is the only credential, and it
 *  identifies exactly one enrollment. */
export const unsubscribeTarget = async (tx: Tx, token: string): Promise<UnsubscribeTarget | null> => {
  const rows = await tx.execute<{
    enrollment_id: string
    account_id: string
    contact_id: string
    contact_email: string | null
    sequence_name: string
    subscription_type_id: string | null
  }>(sql`
    select e.id as enrollment_id, e.account_id, e.contact_id, c.email as contact_email,
           s.name as sequence_name, s.settings ->> 'subscriptionTypeId' as subscription_type_id
      from sequence_enrollment e
      join sequence s on s.id = e.sequence_id
      join contact c on c.id = e.contact_id
     where e.unsubscribe_token = ${token}
     limit 1`)
  const row = rows[0]
  if (!row) return null
  return {
    enrollmentId: row.enrollment_id,
    accountId: row.account_id,
    contactId: row.contact_id,
    contactEmail: row.contact_email,
    sequenceName: row.sequence_name,
    subscriptionTypeId: row.subscription_type_id,
  }
}

/** Records the opt-out itself. Idempotent: a mail client that prefetches the
 *  one-click URL must not produce two different answers from two fetches. */
export const unsubscribeByToken = async (ctx: AccountContext, token: string): Promise<boolean> =>
  withAccount(ctx, async (tx) => {
    const [enrollment] = await tx
      .update(sequenceEnrollment)
      .set({
        state: 'unsubscribed',
        stopReason: 'They used the unsubscribe link.',
        nextRunAt: null,
        finishedAt: new Date(),
        leaseUntil: null,
      })
      // Not already unsubscribed, so a client prefetching the one-click URL and
      // then the person pressing it do not write the event twice.
      .where(
        and(
          eq(sequenceEnrollment.unsubscribeToken, token),
          sql`${sequenceEnrollment.state} <> 'unsubscribed'`,
        ),
      )
      .returning({ id: sequenceEnrollment.id, contactId: sequenceEnrollment.contactId, sequenceId: sequenceEnrollment.sequenceId })
    if (!enrollment) return false

    await tx.insert(sequenceEvent).values({
      accountId: ctx.accountId,
      enrollmentId: enrollment.id,
      kind: 'unsubscribe',
      detail: { via: 'link' },
    })
    const [seq] = await tx.select({ name: sequence.name }).from(sequence).where(eq(sequence.id, enrollment.sequenceId))
    await recordActivity(tx, ctx, {
      type: 'sequence_activity',
      subject: `unsubscribed from ${seq?.name ?? 'a sequence'}`,
      payload: { event: 'unsubscribed', sequenceId: enrollment.sequenceId, sequenceName: seq?.name ?? null, contactName: await contactLabels(tx, [enrollment.contactId]) },
      links: await linksForContacts(tx, [enrollment.contactId]),
    })
    return true
  })

/** The mailbox's own window, when it has one, otherwise the sequence's. */
export const windowFor = (run: ClaimedRun): SendWindow => run.mailboxWindow ?? run.settings.sendWindow

/** Where a pixel, a click and an unsubscribe link point. The tracking domain when
 *  one is set, because sequence mail carrying links on the app's own domain is
 *  how an app domain gets classified as bulk. */
export const trackingBase = (run: ClaimedRun, fallback: string): string =>
  run.trackingDomain ? `https://${run.trackingDomain}` : fallback

export const setTrackingDomain = async (ctx: AccountContext, domain: string | null): Promise<void> =>
  mutate(ctx, 'site', async (tx) => {
    const value = (domain ?? '').trim().toLowerCase()
    if (value !== '' && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
      throw new Error('That is not a hostname. Use something like links.datasaur.ai.')
    }
    await tx.execute(sql`select rawr.set_tracking_domain(${value})`)
    return { result: undefined, audit: { entity: 'account', entityId: ctx.accountId, action: 'set_tracking_domain', after: { domain: value || null } } }
  })

export const readTrackingDomain = async (ctx: AccountContext): Promise<string | null> =>
  withAccount(ctx, async (tx) => {
    const [row] = await tx.execute<{ tracking_domain: string | null }>(
      sql`select tracking_domain from account limit 1`,
    )
    return row?.tracking_domain ?? null
  })

/** Which account a tracking token belongs to.
 *
 *  The pixel, the click and the unsubscribe all arrive from a stranger's mail
 *  client with no session and no scope to pin, so the account has to be found
 *  before row level security can be satisfied. Read on the pool directly and
 *  answering nothing but an id, exactly as the site-key lookup does for the
 *  analytics collector. A token is 24 random bytes: guessing one is not a way in,
 *  and the id alone opens nothing. */
const accountForToken = async (fn: string, token: string): Promise<string | null> => {
  const [row] = await appDb.execute<{ id: string }>(sql`select * from ${sql.raw(fn)}(${token}::text)`)
  return row?.id ?? null
}

export const sendAccountForToken = (token: string): Promise<string | null> =>
  accountForToken('rawr.account_for_send_token', token)

export const linkAccountForToken = (token: string): Promise<string | null> =>
  accountForToken('rawr.account_for_link_token', token)

export const enrollmentAccountForToken = (token: string): Promise<string | null> =>
  accountForToken('rawr.account_for_unsubscribe_token', token)

// --------------------------------------------------------------- templates

export type EmailTemplateRow = {
  id: string
  name: string
  subject: string
  bodyText: string
  authorName: string | null
  updatedAt: Date
}

/** Every template in the account, most recently edited first. Shared, not
 *  personal: the reason to write one down is that a colleague sends it too. */
export const listEmailTemplates = async (ctx: AccountContext): Promise<EmailTemplateRow[]> =>
  withAccount(ctx, (tx) =>
    tx
      .select({
        id: emailTemplate.id,
        name: emailTemplate.name,
        subject: emailTemplate.subject,
        bodyText: emailTemplate.bodyText,
        authorName: userAccount.name,
        updatedAt: emailTemplate.updatedAt,
      })
      .from(emailTemplate)
      .leftJoin(userAccount, eq(userAccount.id, emailTemplate.createdBy))
      .orderBy(desc(emailTemplate.updatedAt))
      .limit(200),
  )

export const saveEmailTemplate = async (
  ctx: AccountContext,
  input: { id?: string | null | undefined; name: string; subject: string; bodyText: string },
): Promise<{ id: string }> =>
  mutate(ctx, 'email_template', async (tx) => {
    const name = input.name.trim()
    if (!name) throw new Error('A template needs a name, or nobody can find it again.')

    const clash = await tx.execute<{ id: string }>(sql`
      select id from email_template
       where lower(name) = ${name.toLowerCase()}
         ${input.id ? sql`and id <> ${input.id}::uuid` : sql``}
       limit 1`)
    if (clash.length > 0) throw new Error(`There is already a template called “${name}”.`)

    if (input.id) {
      const [updated] = await tx
        .update(emailTemplate)
        .set({ name, subject: input.subject, bodyText: input.bodyText, updatedAt: new Date() })
        .where(eq(emailTemplate.id, input.id))
        .returning({ id: emailTemplate.id })
      if (!updated) throw new Error('That template is no longer here.')
      return {
        result: { id: updated.id },
        audit: { entity: 'email_template', entityId: updated.id, action: 'update', after: { name } },
      }
    }

    const [created] = await tx
      .insert(emailTemplate)
      .values({
        accountId: ctx.accountId,
        name,
        subject: input.subject,
        bodyText: input.bodyText,
        createdBy: ctx.actorId,
      })
      .returning({ id: emailTemplate.id })
    if (!created) throw new Error('The template could not be stored.')

    return {
      result: { id: created.id },
      audit: { entity: 'email_template', entityId: created.id, action: 'create', after: { name } },
    }
  })

/** Removing a template never touches the steps written from it. A step holds its
 *  own copy of the words, so deleting the template a sequence was built from does
 *  not silently empty a live sequence. */
export const deleteEmailTemplate = async (ctx: AccountContext, id: string): Promise<void> =>
  mutate(ctx, 'email_template', async (tx) => {
    const [before] = await tx
      .select({ name: emailTemplate.name })
      .from(emailTemplate)
      .where(eq(emailTemplate.id, id))
    if (!before) throw new Error('That template is no longer here.')
    await tx.delete(emailTemplate).where(eq(emailTemplate.id, id))
    return {
      result: undefined,
      audit: { entity: 'email_template', entityId: id, action: 'delete', before: { name: before.name }, after: null },
    }
  })
