import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import type { AccountContext } from '../src/dal/context.ts'
import { withAccount } from '../src/dal/index.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import { ingestMessage, saveMailbox, type IncomingMessage } from '../src/dal/messages.ts'
import { createRecord } from '../src/dal/records.ts'
import { setSubscription } from '../src/dal/subscriptions.ts'
import { setTaskStatus } from '../src/dal/tasks.ts'
import {
  claimEnrollmentRun,
  createStepTask,
  directTracking,
  enroll,
  listEnrollments,
  listSends,
  listSequences,
  readSequence,
  recordClick,
  recordOpen,
  recordSend,
  saveSequence,
  saveSteps,
  setSequenceState,
  setTrackingConsentRequired,
  trackingAllowed,
  unsubscribeByToken,
} from '../src/dal/sequences.ts'
import { SANDBOX, cleanup } from './fixture.ts'

/** The engine, end to end, without Google: enrolment and every rule that refuses
 *  it, the claim that stops two workers sending the same step, and every way a
 *  sequence stops. The one thing not exercised here is the network call itself,
 *  which the dev mailbox stands in for in the app. */

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })

const failures: string[] = []
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const refused = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn()
    return null
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

const stamp = Date.now()

try {
  const [ws] = await owner`select id from account where slug = ${SANDBOX.slug}`
  if (!ws) throw new Error('Seed the database first: pnpm db:seed')
  const accountId = ws.id as string

  const [salesUser] = await owner`select id, email from user_account where email = 'sales@sandbox.test'`
  const [adminUser] = await owner`select id from user_account where email = 'admin@sandbox.test'`

  const ctxFor = (userId: string, editHubs: string[]): AccountContext => ({
    accountId,
    actorId: userId,
    actorKind: 'user',
    isSuperAdmin: editHubs.includes('account'),
    viewHubs: [],
    editHubs: editHubs as AccountContext['editHubs'],
  })
  const sales = ctxFor(salesUser!.id as string, ['contacts', 'sales'])
  const admin = ctxFor(adminUser!.id as string, ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'])
  const viewer = ctxFor(salesUser!.id as string, [])

  const box = await saveMailbox(sales, {
    userId: salesUser!.id as string,
    email: salesUser!.email as string,
    accessToken: `seq-access-${stamp}`,
    refreshToken: `seq-refresh-${stamp}`,
    accessTokenExpiresAt: null,
    canSend: true,
  })

  // A second mailbox that was connected for reading only, to prove enrolling from
  // it is refused. Idempotent, so a failed earlier run does not block this one.
  const [readOnlyBox] = await owner`
    insert into mailbox (account_id, user_id, email, access_token, refresh_token, can_send)
    values (${accountId}, ${adminUser!.id}, ${`readonly-${stamp}@sandbox.test`}, 'x', 'y', false)
    on conflict (account_id, user_id) do update set can_send = false, email = excluded.email
    returning id`

  console.log('-- writing one ---------------------------------------------------')

  const created = await saveSequence(sales, {
    name: `Verify sequence ${stamp}`,
    description: 'Made by the verify suite.',
    // Every day, all hours, so the scheduler never defers inside this run.
    settings: { sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59', timezone: 'UTC' } },
  })
  check(created.id.length > 0, 'a sequence is created')

  // The refusal names the hub that was missing, so the person reading it knows
  // what to ask for rather than which role they are not.
  check(
    (await refused(() => saveSequence(viewer, { name: `Refused ${stamp}` })))?.includes('sales') === true,
    'a read-only seat cannot write one',
  )

  const noSteps = await refused(() => setSequenceState(sales, { id: created.id, state: 'active' }))
  check(noSteps?.includes('Add a step') === true, 'a sequence with no steps cannot be turned on', noSteps ?? '')

  await saveSteps(sales, {
    sequenceId: created.id,
    steps: [
      { kind: 'email', delayDays: 0, delayHours: 0, subject: 'Hello {{first_name|there}}', bodyText: 'A first note.' },
      { kind: 'call', delayDays: 0, delayHours: 0, taskTitle: 'Ring {{first_name|them}}' },
      { kind: 'email', delayDays: 0, delayHours: 0, subject: 'Following up', bodyText: 'A second note.' },
    ],
  })
  // A token nothing can fill is caught where it is typed, and the sentence names
  // it rather than leaving somebody to hunt through four bodies for the typo.
  const badStep = await refused(() =>
    saveSteps(sales, {
      sequenceId: created.id,
      steps: [
        { kind: 'email', delayDays: 0, delayHours: 0, subject: 'Hi {{contact.first_name}}', bodyText: 'A note.' },
      ],
    }),
  )
  check(
    badStep?.includes('{{contact.first_name}}') === true,
    'a step using a merge field nothing can fill is refused',
    badStep ?? '',
  )

  const withSteps = await readSequence(sales, created.id)
  check(withSteps?.steps.length === 3, 'the steps are saved in order', `${withSteps?.steps.length ?? 0}`)
  check(withSteps?.steps[1]?.kind === 'call', 'and keep the order they were given', withSteps?.steps[1]?.kind ?? '')

  // Written straight to the row, because saveSteps now refuses it: what is being
  // checked is a sequence that predates the rule, or arrived by import.
  await owner`update sequence_step set subject = 'Hi {{contact.first_name}}'
               where sequence_id = ${created.id}::uuid and position = 0`
  const badActivate = await refused(() => setSequenceState(sales, { id: created.id, state: 'active' }))
  check(
    badActivate?.includes('{{contact.first_name}}') === true,
    'and a sequence already holding one cannot be turned on',
    badActivate ?? '',
  )
  await owner`update sequence_step set subject = 'Hello {{first_name|there}}'
               where sequence_id = ${created.id}::uuid and position = 0`

  await setSequenceState(sales, { id: created.id, state: 'active' })
  check((await readSequence(sales, created.id))?.sequence.state === 'active', 'and it turns on once it has steps')

  console.log('')
  console.log('-- who goes in ----------------------------------------------------')

  const person = await createRecord(admin, 'contact', {
    first_name: 'Verify',
    last_name: 'Prospect',
    email: `seq-${stamp}@partner1.example`,
  })
  const noEmail = await createRecord(admin, 'contact', { first_name: 'No', last_name: 'Address' })

  const outcomes = await enroll(sales, {
    sequenceId: created.id,
    contactIds: [person.id, noEmail.id],
    mailboxId: box.id,
  })
  check(outcomes.find((row) => row.contactId === person.id)?.enrolled === true, 'somebody with an address goes in')
  check(
    outcomes.find((row) => row.contactId === noEmail.id)?.reason === 'No email address.',
    'and somebody without one is refused, by name',
  )

  const again = await enroll(sales, { sequenceId: created.id, contactIds: [person.id], mailboxId: box.id })
  check(again[0]?.reason === 'Already in this sequence.', 'enrolling the same person twice is refused')

  const readOnly = await refused(() =>
    enroll(sales, { sequenceId: created.id, contactIds: [person.id], mailboxId: readOnlyBox!.id as string }),
  )
  check(readOnly?.includes('reading only') === true, 'a mailbox that cannot send cannot be enrolled from', readOnly ?? '')

  const [enrollment] = await listEnrollments(sales, { sequenceId: created.id })
  check(enrollment?.state === 'active', 'the enrollment is running', enrollment?.state ?? '')

  console.log('')
  console.log('-- the queue ------------------------------------------------------')

  const claim = (await claimEnrollmentRun(sales, enrollment!.id)).claimed
  check(claim !== null, 'the scheduler can claim it')
  check(claim?.step?.position === 0, 'and is handed the step it is on', String(claim?.step?.position))
  check(claim?.contactEmail === `seq-${stamp}@partner1.example`, 'with everything the send needs')
  check(
    claim?.enrolledBy === (salesUser!.id as string),
    'and told who enrolled them, so a task step is somebody\u2019s',
  )

  const second = await claimEnrollmentRun(sales, enrollment!.id)
  check(second.claimed === null, 'a second worker cannot claim the same run')
  check(
    second.claimed === null && second.reason === 'Not due, or already being run.',
    'and is told why rather than nothing',
    second.claimed === null ? second.reason : '',
  )

  // Standing in for the send: exactly what the app records after Gmail answers.
  const sendToken = `tok-${stamp}`
  const linkToken = `link-${stamp}`
  const recorded = await recordSend(sales, {
    enrollmentId: enrollment!.id,
    stepId: claim!.step!.id,
    mailboxId: box.id,
    providerMessageId: `pm-${stamp}`,
    internetMessageId: `<seq-${stamp}@sandbox.test>`,
    token: sendToken,
    links: [{ token: linkToken, url: 'https://datasaur.ai/pricing' }],
    subject: 'Hello there',
    contactId: person.id,
  })
  check(recorded.sendId.length > 0, 'the send is recorded')

  const advanced = await listEnrollments(sales, { sequenceId: created.id })
  check(advanced[0]?.currentStep === 1, 'and the enrollment moves to the next step', String(advanced[0]?.currentStep))

  console.log('')
  console.log('-- tracking -------------------------------------------------------')

  check(await recordOpen(sales, sendToken, { userAgent: 'Test' }), 'an open is counted')
  await recordOpen(sales, sendToken, { userAgent: 'Test' })
  const [opens] = await owner`select open_count, first_opened_at from sequence_send where token = ${sendToken}`
  check(Number(opens?.open_count) === 2, 'twice means two, not one', String(opens?.open_count))
  check(opens?.first_opened_at !== null, 'and the first one is kept separately')

  const clicked = await recordClick(sales, linkToken, {})
  check(clicked === 'https://datasaur.ai/pricing', 'a click returns the stored URL, never one from the request', clicked ?? '')
  check((await recordClick(sales, `nope-${stamp}`, {})) === null, 'an unknown token redirects nowhere')

  console.log('')
  console.log('-- who may be measured --------------------------------------------')

  // The rule itself, both ways round, because everything below rests on it.
  check(trackingAllowed(false, null), 'silence is measurable when the account does not ask')
  check(!trackingAllowed(true, null), 'and is not, when it does')
  check(trackingAllowed(true, 'Allowed'), 'agreeing is enough even when the account asks')
  check(!trackingAllowed(false, 'Never'), 'and refusing wins even when it does not')

  check((await directTracking(sales, person.id)).allowed, 'a contact nobody asked is tracked by default')

  await owner`update contact set tracking_consent = 'Never' where id = ${person.id}`
  check(!(await directTracking(sales, person.id)).allowed, 'until they say never')

  await owner`update contact set tracking_consent = 'Allowed' where id = ${person.id}`
  await setTrackingConsentRequired(admin, true)
  check((await directTracking(sales, person.id)).allowed, 'agreeing survives the account asking')

  await owner`update contact set tracking_consent = null where id = ${person.id}`
  check(!(await directTracking(sales, person.id)).allowed, 'and silence does not')

  // No contact means nobody to have asked, so nothing is carried.
  check(!(await directTracking(sales, null)).allowed, 'mail to a bare address is never tracked')

  const gated = (await claimEnrollmentRun(sales, enrollment!.id)).claimed
  check(gated === null || gated.trackingAllowed === false, 'the worker is handed the refusal, not the rule')

  await setTrackingConsentRequired(admin, false)

  console.log('')
  console.log('-- how it stops ---------------------------------------------------')

  // A task step: the enrollment waits, and completing the task moves it on.
  const waiting = await createStepTask(sales, {
    enrollmentId: enrollment!.id,
    contactId: person.id,
    title: 'Ring them',
    body: null,
    assigneeId: salesUser!.id as string,
  })
  const parked = await listEnrollments(sales, { sequenceId: created.id })
  check(parked[0]?.state === 'waiting_task', 'a task step parks the enrollment', parked[0]?.state ?? '')

  await setTaskStatus(sales, waiting.taskId, 'done')
  const resumed = await listEnrollments(sales, { sequenceId: created.id })
  check(resumed[0]?.state === 'active', 'and completing the task resumes it', resumed[0]?.state ?? '')
  check(resumed[0]?.currentStep === 2, 'onto the step after the task', String(resumed[0]?.currentStep))

  // A reply, arriving the way a real one does: through the mailbox sync.
  const reply: IncomingMessage = {
    providerThreadId: `seq-thread-${stamp}`,
    providerMessageId: `reply-${stamp}`,
    subject: 'Re: Hello there',
    from: `seq-${stamp}@partner1.example`,
    to: [salesUser!.email as string],
    cc: [],
    sentAt: new Date(),
    snippet: 'Sounds good.',
    internetMessageId: `<reply-${stamp}@partner1.example>`,
    inReplyTo: `<seq-${stamp}@sandbox.test>`,
    references: [`<seq-${stamp}@sandbox.test>`],
    hasAttachments: false,
  }
  await ingestMessage(sales, {
    incoming: reply,
    ownerEmail: salesUser!.email as string,
    mailboxId: box.id,
    internalDomain: 'datasaur.ai',
    blocked: new Set(),
  })
  const afterReply = await listEnrollments(sales, { sequenceId: created.id })
  check(afterReply[0]?.state === 'replied', 'a reply stops the sequence', afterReply[0]?.state ?? '')
  check(
    afterReply[0]?.stopReason?.includes('replied') === true,
    'and says so where somebody will read it',
    afterReply[0]?.stopReason ?? '',
  )

  const [replyEvent] = await owner`
    select count(*)::int as n from sequence_event
     where enrollment_id = ${enrollment!.id} and kind = 'reply'`
  check(Number(replyEvent?.n) === 1, 'the reply is on the ledger once')

  // An auto-reply is not a reply.
  const second_person = await createRecord(admin, 'contact', {
    first_name: 'Auto',
    last_name: 'Responder',
    email: `auto-${stamp}@partner1.example`,
  })
  await enroll(sales, { sequenceId: created.id, contactIds: [second_person.id], mailboxId: box.id })
  const [autoEnrollment] = (await listEnrollments(sales, { sequenceId: created.id })).filter(
    (row) => row.contactId === second_person.id,
  )
  const autoClaim = (await claimEnrollmentRun(sales, autoEnrollment!.id)).claimed
  await recordSend(sales, {
    enrollmentId: autoEnrollment!.id,
    stepId: autoClaim!.step!.id,
    mailboxId: box.id,
    providerMessageId: `pm-auto-${stamp}`,
    internetMessageId: `<auto-out-${stamp}@sandbox.test>`,
    token: `tok-auto-${stamp}`,
    links: [],
    subject: 'Hello',
    contactId: second_person.id,
  })
  await ingestMessage(sales, {
    incoming: {
      ...reply,
      providerThreadId: `auto-thread-${stamp}`,
      providerMessageId: `auto-reply-${stamp}`,
      from: `auto-${stamp}@partner1.example`,
      internetMessageId: `<auto-reply-${stamp}@partner1.example>`,
      inReplyTo: `<auto-out-${stamp}@sandbox.test>`,
      references: [`<auto-out-${stamp}@sandbox.test>`],
      subject: 'Out of office',
      headers: { 'auto-submitted': 'auto-replied' },
    },
    ownerEmail: salesUser!.email as string,
    mailboxId: box.id,
    internalDomain: 'datasaur.ai',
    blocked: new Set(),
  })
  const afterAuto = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === second_person.id,
  )
  check(afterAuto?.state === 'active', 'an out-of-office does not stop it', afterAuto?.state ?? '')

  // A bounce.
  const third = await createRecord(admin, 'contact', {
    first_name: 'Bounce',
    last_name: 'Target',
    email: `bounce-${stamp}@partner1.example`,
  })
  await enroll(sales, { sequenceId: created.id, contactIds: [third.id], mailboxId: box.id })
  const bounceEnrollment = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === third.id,
  )
  const bounceClaim = (await claimEnrollmentRun(sales, bounceEnrollment!.id)).claimed
  await recordSend(sales, {
    enrollmentId: bounceEnrollment!.id,
    stepId: bounceClaim!.step!.id,
    mailboxId: box.id,
    providerMessageId: `pm-b-${stamp}`,
    internetMessageId: `<bounce-out-${stamp}@sandbox.test>`,
    token: `tok-b-${stamp}`,
    links: [],
    subject: 'Hello',
    contactId: third.id,
  })
  await ingestMessage(sales, {
    incoming: {
      ...reply,
      providerThreadId: `bounce-thread-${stamp}`,
      providerMessageId: `bounce-msg-${stamp}`,
      from: 'mailer-daemon@googlemail.com',
      internetMessageId: `<bounce-${stamp}@googlemail.com>`,
      inReplyTo: `<bounce-out-${stamp}@sandbox.test>`,
      references: [`<bounce-out-${stamp}@sandbox.test>`],
      subject: 'Delivery Status Notification (Failure)',
    },
    ownerEmail: salesUser!.email as string,
    mailboxId: box.id,
    internalDomain: 'datasaur.ai',
    blocked: new Set(),
  })
  const afterBounce = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === third.id,
  )
  check(afterBounce?.state === 'bounced', 'a delivery failure stops it as a bounce', afterBounce?.state ?? '')

  // The unsubscribe link.
  const fourth = await createRecord(admin, 'contact', {
    first_name: 'Opt',
    last_name: 'Out',
    email: `opt-${stamp}@partner1.example`,
  })
  await enroll(sales, { sequenceId: created.id, contactIds: [fourth.id], mailboxId: box.id })
  const [optToken] = await owner`
    select e.unsubscribe_token from sequence_enrollment e
     where e.sequence_id = ${created.id} and e.contact_id = ${fourth.id}`
  check(await unsubscribeByToken(sales, optToken!.unsubscribe_token as string), 'the unsubscribe link works')
  check(
    !(await unsubscribeByToken(sales, optToken!.unsubscribe_token as string)),
    'and pressing it twice changes nothing the second time',
  )
  const afterOptOut = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === fourth.id,
  )
  check(afterOptOut?.state === 'unsubscribed', 'the enrollment reads as unsubscribed', afterOptOut?.state ?? '')

  // Opting out on the record stops the outreach too.
  const [type] = await owner`select id from subscription_type where account_id = ${accountId} limit 1`
  await saveSequence(sales, {
    id: created.id,
    name: `Verify sequence ${stamp}`,
    settings: { subscriptionTypeId: type!.id as string },
  })
  const fifth = await createRecord(admin, 'contact', {
    first_name: 'Record',
    last_name: 'OptOut',
    email: `record-opt-${stamp}@partner1.example`,
  })
  await enroll(sales, { sequenceId: created.id, contactIds: [fifth.id], mailboxId: box.id })
  await setSubscription(admin, { contactId: fifth.id, typeId: type!.id as string, state: 'unsubscribed' })
  const afterRecordOptOut = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === fifth.id,
  )
  check(
    afterRecordOptOut?.state === 'unsubscribed',
    'unsubscribing on the record stops the outreach as well as the newsletter',
    afterRecordOptOut?.state ?? '',
  )

  const blockedNow = await enroll(sales, { sequenceId: created.id, contactIds: [fifth.id], mailboxId: box.id })
  check(
    blockedNow[0]?.reason?.includes('opted out') === true,
    'and they cannot be enrolled again',
    blockedNow[0]?.reason ?? '',
  )

  console.log('')
  console.log('-- reporting ------------------------------------------------------')

  const listed = (await listSequences(sales)).find((row) => row.id === created.id)
  check(listed !== undefined, 'the sequence is listed with its numbers')
  // Three were sent and one of them bounced, which stops counting as sent: a
  // delivery rate that includes mail that never arrived is not a rate.
  check(listed?.stats.sent === 2, 'sends are counted, and a bounced one is not one of them', String(listed?.stats.sent))
  check(listed?.stats.replied === 1, 'and so are replies', String(listed?.stats.replied))
  check(listed?.stats.bounced === 1, 'and bounces', String(listed?.stats.bounced))
  check(listed?.stats.unsubscribed === 2, 'and opt-outs', String(listed?.stats.unsubscribed))

  console.log('')
  console.log('-- what can never send --------------------------------------------')

  // The five production enrollments this section is about: the mailbox row went,
  // the foreign key nulled the column, and the claim took a lease every minute
  // for ever without ever being able to send.
  const orphanOf = await createRecord(admin, 'contact', {
    first_name: 'Orphan',
    last_name: 'Mailbox',
    email: `orphan-${stamp}@partner1.example`,
  })
  await enroll(sales, { sequenceId: created.id, contactIds: [orphanOf.id], mailboxId: box.id })
  const orphan = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === orphanOf.id,
  )
  await owner`
    update sequence_enrollment set mailbox_id = null, next_run_at = now()
     where id = ${orphan!.id}`

  const noMailbox = await claimEnrollmentRun(sales, orphan!.id)
  check(noMailbox.claimed === null, 'an enrollment with no mailbox is not handed to the worker')
  check(
    noMailbox.claimed === null && noMailbox.reason.includes('mailbox'),
    'and the worker is told what is wrong, not "not due"',
    noMailbox.claimed === null ? noMailbox.reason.slice(0, 60) : '',
  )
  const [orphanRow] = await owner`
    select state, lease_until, next_run_at, stop_reason from sequence_enrollment where id = ${orphan!.id}`
  check(orphanRow?.state === 'failed', 'it is stopped where it is found', String(orphanRow?.state))
  check(
    orphanRow?.lease_until === null && orphanRow?.next_run_at === null,
    'with the lease released, so it cannot claim one a minute for ever',
  )
  check(
    String(orphanRow?.stop_reason ?? '').length > 60,
    'and says on the record what happened and what to do about it',
  )
  const [orphanEvent] = await owner`
    select count(*)::int as n from sequence_event
     where enrollment_id = ${orphan!.id} and kind = 'stopped'`
  check(Number(orphanEvent?.n) === 1, 'the stop is on the ledger like any other')

  const addressless = await createRecord(admin, 'contact', {
    first_name: 'Lost',
    last_name: 'Address',
    email: `lost-${stamp}@partner1.example`,
  })
  await enroll(sales, { sequenceId: created.id, contactIds: [addressless.id], mailboxId: box.id })
  const lost = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === addressless.id,
  )
  await owner`update contact set email = null where id = ${addressless.id}`
  await owner`update sequence_enrollment set next_run_at = now() where id = ${lost!.id}`
  const noAddress = await claimEnrollmentRun(sales, lost!.id)
  check(
    noAddress.claimed === null && noAddress.reason.includes('email address'),
    'a contact whose address was cleared stops the enrollment by name',
    noAddress.claimed === null ? noAddress.reason.slice(0, 60) : '',
  )

  // Depends on migration 0063: fails until it has been applied.
  const [stillOrphaned] = await owner`
    select count(*)::int as n from sequence_enrollment e
      join contact c on c.id = e.contact_id
     where e.state in ('active', 'waiting_task')
       and (e.mailbox_id is null or c.email is null or btrim(c.email) = '')`
  check(Number(stillOrphaned?.n) === 0, 'no enrollment anywhere is left in a state it cannot send from')

  console.log('')
  console.log('-- the mailbox is what paces the sending --------------------------')

  const paced = await createRecord(admin, 'contact', {
    first_name: 'Paced',
    last_name: 'Prospect',
    email: `paced-${stamp}@partner1.example`,
  })
  await enroll(sales, { sequenceId: created.id, contactIds: [paced.id], mailboxId: box.id })
  const pacedEnrollment = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === paced.id,
  )
  // A send that never left, on the same mailbox. It reached nobody, so it neither
  // spends the day's allowance nor counts as the last thing this mailbox sent.
  await owner`
    insert into sequence_send (account_id, mailbox_id, contact_id, token, state, sent_at)
    values (${accountId}, ${box.id}, ${paced.id}, ${`tok-failed-${stamp}`}, 'failed', now())`

  const pacedClaim = (await claimEnrollmentRun(sales, pacedEnrollment!.id)).claimed
  const [counted] = await owner`
    select count(*)::int as n, max(d.sent_at) as last_at from sequence_send d
     where d.mailbox_id = ${box.id} and d.enrollment_id is not null and d.state <> 'failed'
       and d.sent_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC'`
  check(
    pacedClaim?.sentToday === Number(counted?.n),
    'the day\u2019s count is the mail that went, not the mail that failed',
    `${pacedClaim?.sentToday} vs ${counted?.n}`,
  )
  check(
    pacedClaim?.mailboxLastSentAt !== null && pacedClaim?.lastSentAt === null,
    'the gap is measured from the mailbox\u2019s last send, not this enrollment\u2019s first',
  )
  check(
    pacedClaim?.enrolledBy === (salesUser!.id as string),
    'and the step\u2019s task belongs to whoever enrolled them',
  )

  console.log('')
  console.log('-- a bounce that does not look like one ---------------------------')

  const quiet = await createRecord(admin, 'contact', {
    first_name: 'Quiet',
    last_name: 'Bounce',
    email: `quiet-${stamp}@partner1.example`,
  })
  await enroll(sales, { sequenceId: created.id, contactIds: [quiet.id], mailboxId: box.id })
  const quietEnrollment = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === quiet.id,
  )
  const quietClaim = (await claimEnrollmentRun(sales, quietEnrollment!.id)).claimed
  await recordSend(sales, {
    enrollmentId: quietEnrollment!.id,
    stepId: quietClaim!.step!.id,
    mailboxId: box.id,
    providerMessageId: `pm-quiet-${stamp}`,
    internetMessageId: `<quiet-out-${stamp}@sandbox.test>`,
    token: `tok-quiet-${stamp}`,
    links: [],
    subject: 'Hello',
    contactId: quiet.id,
  })

  // A provider that sends its delivery reports from an ordinary address. Nothing
  // in the from line says bounce; the Content-Type does, which is the only thing
  // RFC 3464 guarantees.
  await ingestMessage(sales, {
    incoming: {
      ...reply,
      providerThreadId: `quiet-thread-${stamp}`,
      providerMessageId: `quiet-report-${stamp}`,
      from: `notifications-${stamp}@relay.example`,
      internetMessageId: `<quiet-report-${stamp}@relay.example>`,
      inReplyTo: `<quiet-out-${stamp}@sandbox.test>`,
      references: [`<quiet-out-${stamp}@sandbox.test>`],
      subject: 'Undeliverable',
      headers: { 'content-type': 'multipart/report; report-type=delivery-status; boundary=x' },
    },
    ownerEmail: salesUser!.email as string,
    mailboxId: box.id,
    internalDomain: 'datasaur.ai',
    blocked: new Set(),
  })
  const afterQuiet = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === quiet.id,
  )
  check(
    afterQuiet?.state === 'bounced',
    'a delivery report from an ordinary address still reads as a bounce',
    afterQuiet?.state ?? '',
  )

  console.log('')
  console.log('-- one mail, one row ----------------------------------------------')

  // Depends on migration 0063: without the unique index the second call writes a
  // second row and the step advances twice.
  const repeated = await refused(() =>
    recordSend(sales, {
      enrollmentId: quietEnrollment!.id,
      stepId: quietClaim!.step!.id,
      mailboxId: box.id,
      providerMessageId: `pm-quiet-${stamp}`,
      internetMessageId: `<quiet-out-${stamp}@sandbox.test>`,
      token: `tok-quiet-again-${stamp}`,
      links: [],
      subject: 'Hello',
      contactId: quiet.id,
    }),
  )
  const [sendRows] = await owner`
    select count(*)::int as n from sequence_send where provider_message_id = ${`pm-quiet-${stamp}`}`
  check(
    repeated === null && Number(sendRows?.n) === 1,
    'recording the same provider message twice leaves one row',
    `${sendRows?.n} row(s)${repeated ? `, refused: ${repeated}` : ''}`,
  )

  console.log('')
  console.log('-- what one sequence actually sent ---------------------------------')

  const sent = await listSends(sales, { sequenceId: created.id })
  const mine = sent.rows.find((row) => row.contactId === person.id)
  check(!!mine, 'the drill-down lists the send by contact', `${sent.rows.length} row(s)`)
  check(
    mine?.openCount === 2 && mine.clickCount === 1,
    'with the opens and clicks that were counted against it',
    `${mine?.openCount ?? 0} open(s), ${mine?.clickCount ?? 0} click(s)`,
  )
  check(
    mine?.stepPosition === 0 && mine.state === 'sent' && !mine.bounced,
    'and the step it belongs to',
    `step ${mine?.stepPosition ?? -1}, ${mine?.state ?? 'gone'}`,
  )
  const bouncedOnly = await listSends(sales, { sequenceId: created.id, state: 'bounced' })
  check(
    !bouncedOnly.rows.some((row) => row.state !== 'bounced'),
    'the state filter returns only that state',
    `${bouncedOnly.rows.length} row(s)`,
  )
  const firstOnly = await listSends(sales, { sequenceId: created.id, limit: 1 })
  check(
    firstOnly.rows.length <= 1,
    'and the page is bounded rather than reading every send in the account',
    `${firstOnly.rows.length} row(s), more: ${firstOnly.hasMore}`,
  )

  console.log('')
  console.log('-- what the queue rests on ----------------------------------------')

  // All three depend on migration 0063.
  const [queueIndex] = await owner`
    select count(*)::int as n from pg_indexes
     where schemaname = 'public' and indexname = 'sequence_enrollment_queue_idx'`
  check(
    Number(queueIndex?.n) === 1,
    'the cross-tenant dispatch has an index that does not lead with the account',
  )
  const [sendIndex] = await owner`
    select count(*)::int as n from pg_indexes
     where schemaname = 'public' and indexname = 'sequence_send_provider_key'`
  check(Number(sendIndex?.n) === 1, 'and one message id can only be recorded once')
  const [attempts] = await owner`
    select is_nullable from information_schema.columns
     where table_schema = 'public' and table_name = 'dead_letter' and column_name = 'attempts'`
  check(
    attempts?.is_nullable === 'YES',
    'a failure that was never queued can say so rather than claim nought tries',
    String(attempts?.is_nullable),
  )

  console.log('')
  // Everything this script made goes with it.
  await withAccount(admin, async (tx) => {
    await tx.execute(sql`delete from sequence where id = ${created.id}::uuid`)
  })
  await owner`delete from message_thread where provider_thread_id like ${`%-${stamp}`}`
  await owner`delete from mailbox where id in (${box.id}, ${readOnlyBox!.id})`
  await owner`delete from contact where account_id = ${accountId} and (email like ${`seq-${stamp}%`} or email like ${`auto-${stamp}%`} or email like ${`bounce-${stamp}%`} or email like ${`opt-${stamp}%`} or email like ${`record-opt-${stamp}%`} or email like ${`orphan-${stamp}%`} or email like ${`lost-${stamp}%`} or email like ${`paced-${stamp}%`} or email like ${`quiet-${stamp}%`} or (first_name = 'Lost' and last_name = 'Address') or (first_name = 'No' and last_name = 'Address'))`
} finally {
  await Promise.all([owner.end(), closeAppPool()])
  await cleanup()
}

if (failures.length) {
  console.error(`\n${failures.length} sequence check(s) failed.`)
  process.exit(1)
}
console.log('\nall sequence checks passed.')
