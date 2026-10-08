import { sql } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import postgres from 'postgres'
import type { AccountContext } from '../src/dal/context.ts'
import { withAccount } from '../src/dal/index.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import { ingestMessage, saveMailbox, type IncomingMessage } from '../src/dal/messages.ts'
import { createRecord, deleteRecord, mergeRecords } from '../src/dal/records.ts'
import { createSubscriptionType, deleteSubscriptionType, setSubscription, unsubscribeByToken } from '../src/dal/subscriptions.ts'
import { saveAutomation } from '../src/dal/automations.ts'
import { setTaskStatus } from '../src/dal/tasks.ts'
import {
  cloneSequence,
  claimEnrollmentRun,
  createStepTask,
  deleteSequence,
  directTracking,
  enroll,
  enrollPreview,
  type EnrollOutcome,
  listEnrollments,
  listSends,
  listSequences,
  pauseEnrollment,
  readSequence,
  removeEnrollment,
  recordClick,
  recordOpen,
  recordSend,
  recordSendFailure,
  resumeEnrollment,
  saveSequence,
  saveSteps,
  setSequenceState,
  setTrackingConsentRequired,
  trackingAllowed,
  type SequenceStep,
} from '../src/dal/sequences.ts'
import { publicEdgeContext } from '../src/dal/forms.ts'
import { PEER, SANDBOX, cleanup, seatFor } from './fixture.ts'

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

const reasonOf = (row: EnrollOutcome | undefined): string | undefined => (row && !row.enrolled ? row.reason : undefined)

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
    reasonOf(outcomes.find((row) => row.contactId === noEmail.id)) === 'No email address.',
    'and somebody without one is refused, by name',
  )

  // Whoever is deleted or merged away must stop receiving the sequence.
  const goner = await createRecord(admin, 'contact', { first_name: 'Verify', last_name: 'Deleted', email: `seq-gone-${stamp}@partner1.example` })
  const absorbed = await createRecord(admin, 'contact', { first_name: 'Verify', last_name: 'Merged', email: `seq-merged-${stamp}@partner1.example` })
  await enroll(sales, { sequenceId: created.id, contactIds: [goner.id, absorbed.id], mailboxId: box.id })
  await deleteRecord(admin, 'contact', goner.id)
  await mergeRecords(admin, { objectKey: 'contact', survivorId: noEmail.id, absorbedId: absorbed.id, picks: {} })
  const left = await owner`select contact_id, state from sequence_enrollment where contact_id in (${goner.id}, ${absorbed.id})`
  check(
    left.length === 2 && left.every((row) => row.state === 'removed'),
    'a contact deleted or merged away is taken out of the sequence',
    left.map((row) => row.state).join(', '),
  )

  const again = await enroll(sales, { sequenceId: created.id, contactIds: [person.id], mailboxId: box.id })
  check(reasonOf(again[0]) === 'Already in this sequence.', 'enrolling the same person twice is refused')

  // The preview gives the answer enroll gives, and writes nothing. It writes to a
  // sequence of its own, so the enrolments the checks below read keep their order.
  const previewed = await saveSequence(sales, {
    name: `Verify preview ${stamp}`,
    settings: { sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59', timezone: 'UTC' } },
  })
  const fresh = await createRecord(admin, 'contact', { first_name: 'Verify', last_name: 'Preview', email: `seq-preview-${stamp}@partner1.example` })
  const previewInput = { sequenceId: previewed.id, contactIds: [person.id, noEmail.id, fresh.id], mailboxId: box.id }
  const preview = await enrollPreview(sales, previewInput)
  const [wrote] = await owner`select count(*)::int as n from sequence_enrollment where sequence_id = ${previewed.id}::uuid`
  check(preview.willEnroll === 2 && wrote?.n === 0, 'the preview counts who would go in and writes nothing', `${preview.willEnroll} would enroll`)
  check(
    preview.refused.length === 1 && preview.refused[0]?.contactId === noEmail.id && preview.refused[0]?.reason === 'No email address.',
    'and names each refused contact with the reason',
  )
  const alreadyPreview = await enrollPreview(sales, { sequenceId: created.id, contactIds: [person.id], mailboxId: box.id })
  check(alreadyPreview.refused[0]?.reason === 'Already in this sequence.', 'the preview gives the same reason enroll gives for a repeat')
  const previewReadOnly = await refused(() => enrollPreview(sales, { ...previewInput, mailboxId: readOnlyBox!.id as string }))
  check(previewReadOnly?.includes('reading only') === true, 'the preview refuses the same mailbox enroll refuses', previewReadOnly ?? '')
  const applied = await enroll(sales, previewInput)
  check(
    applied.filter((row) => row.enrolled).length === preview.willEnroll && applied.filter((row) => !row.enrolled).length === preview.refused.length,
    'enroll then takes the count the preview promised',
    `${applied.filter((row) => row.enrolled).length} enrolled, ${applied.filter((row) => !row.enrolled).length} refused`,
  )

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

  // No headers, only the subject: the same out-of-office is still not a reply.
  await ingestMessage(sales, {
    incoming: {
      ...reply,
      providerThreadId: `auto-thread-${stamp}`,
      providerMessageId: `auto-subject-${stamp}`,
      from: `auto-${stamp}@partner1.example`,
      internetMessageId: `<auto-subject-${stamp}@partner1.example>`,
      inReplyTo: `<auto-out-${stamp}@sandbox.test>`,
      references: [`<auto-out-${stamp}@sandbox.test>`],
      subject: 'Out of Office until Monday',
      headers: undefined,
    },
    ownerEmail: salesUser!.email as string,
    mailboxId: box.id,
    internalDomain: 'datasaur.ai',
    blocked: new Set(),
  })
  const afterSubject = (await listEnrollments(sales, { sequenceId: created.id })).find(
    (row) => row.contactId === second_person.id,
  )
  check(afterSubject?.state === 'active', 'a subject-only out-of-office does not stop it', afterSubject?.state ?? '')
  const [flagged] = await owner`
    select count(*)::int as n from message
     where provider_message_id in (${`auto-reply-${stamp}`}, ${`auto-subject-${stamp}`}) and is_auto_reply`
  check(Number(flagged?.n) === 2, 'both out-of-office messages are stored as auto-replies', String(flagged?.n))

  // Google being busy is not the enrollment's fault: the step is tried again, a
  // finite number of times, and only then does the enrollment fail. A failure
  // that is about what was asked for stops it at once.
  const [flaky, refusedMail] = await Promise.all(
    ['flaky', 'refused'].map((name) =>
      createRecord(admin, 'contact', { first_name: name, last_name: 'Send', email: `${name}-${stamp}@partner1.example` }),
    ),
  )
  await enroll(sales, { sequenceId: created.id, contactIds: [flaky!.id, refusedMail!.id], mailboxId: box.id })
  const attemptFor = async (contactId: string) => {
    const row = (await listEnrollments(sales, { sequenceId: created.id })).find((entry) => entry.contactId === contactId)!
    const claimed = (await claimEnrollmentRun(sales, row.id)).claimed
    return { enrollmentId: row.id, stepId: claimed!.step!.id, mailboxId: box.id, error: 'Gmail answered 503' }
  }
  const flakyAttempt = await attemptFor(flaky!.id)
  const retries: boolean[] = []
  for (let i = 0; i < 5; i++) retries.push(await recordSendFailure(sales, { ...flakyAttempt, transient: true }))
  check(
    retries.slice(0, 4).every(Boolean) && retries[4] === false,
    'a transient send failure is retried four times and the fifth fails the enrollment',
    retries.join(','),
  )
  const [flakyState] = await owner`select state from sequence_enrollment where id = ${flakyAttempt.enrollmentId}`
  check(flakyState?.state === 'failed', 'and it is then failed', String(flakyState?.state))

  const refusedAttempt = await attemptFor(refusedMail!.id)
  check(
    (await recordSendFailure(sales, { ...refusedAttempt, error: 'Gmail answered 400', transient: false })) === false,
    'a permanent send failure fails it at once',
  )
  const [refusedState] = await owner`select state from sequence_enrollment where id = ${refusedAttempt.enrollmentId}`
  check(refusedState?.state === 'failed', 'and the enrollment is failed', String(refusedState?.state))

  const waiter = await createRecord(admin, 'contact', { first_name: 'Wait', last_name: 'Send', email: `wait-${stamp}@partner1.example` })
  await enroll(sales, { sequenceId: created.id, contactIds: [waiter.id], mailboxId: box.id })
  const waitAttempt = await attemptFor(waiter.id)
  await recordSendFailure(sales, { ...waitAttempt, transient: true })
  const [queuedAgain] = await owner`
    select state, next_run_at > now() + interval '4 minutes' as later, lease_until is null as free
      from sequence_enrollment where id = ${waitAttempt.enrollmentId}`
  check(
    queuedAgain?.state === 'active' && queuedAgain.later === true && queuedAgain.free === true,
    'a retried step waits for its next try, still active, with its lease released',
  )

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
  const [kept] = await owner`select description from sequence where id = ${created.id}`
  check(kept?.description === 'Made by the verify suite.', 'saving settings keeps the description', kept?.description ?? 'null')
  await saveSequence(sales, { id: created.id, name: `Verify sequence ${stamp}`, description: '  ' })
  const [cleared] = await owner`select description from sequence where id = ${created.id}`
  check(cleared?.description === null, 'a blank description clears it', String(cleared?.description))
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
    reasonOf(blockedNow[0])?.includes('opted out') === true,
    'and they cannot be enrolled again',
    reasonOf(blockedNow[0]) ?? '',
  )

  console.log('')
  console.log('-- the unsubscribe link ------------------------------------------')

  // The same scope the public link route builds: a stranger, with marketing and nothing else.
  const publicScope = { ...publicEdgeContext(accountId), actorKind: 'public' as const }
  const everyDay = { sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59', timezone: 'UTC' } }
  const optA = await createSubscriptionType(admin, { name: `Verify unsub A ${stamp}` })
  const optB = await createSubscriptionType(admin, { name: `Verify unsub B ${stamp}` })
  const seqA1 = await saveSequence(sales, { name: `Verify unsub A1 ${stamp}`, settings: { ...everyDay, subscriptionTypeId: optA.id } })
  const seqA2 = await saveSequence(sales, { name: `Verify unsub A2 ${stamp}`, settings: { ...everyDay, subscriptionTypeId: optA.id } })
  const seqB = await saveSequence(sales, { name: `Verify unsub B ${stamp}`, settings: { ...everyDay, subscriptionTypeId: optB.id } })
  const seqNone = await saveSequence(sales, { name: `Verify unsub none ${stamp}`, settings: everyDay })
  const olive = await createRecord(admin, 'contact', { first_name: 'Olive', last_name: 'Opted', email: `unsub-${stamp}-x@partner1.example` })
  const yara = await createRecord(admin, 'contact', { first_name: 'Yara', last_name: 'Typeless', email: `unsub-${stamp}-y@partner1.example` })
  for (const sequenceId of [seqA1.id, seqA2.id, seqB.id]) {
    await enroll(sales, { sequenceId, contactIds: [olive.id], mailboxId: box.id })
  }
  for (const sequenceId of [seqNone.id, seqA1.id, seqB.id]) {
    await enroll(sales, { sequenceId, contactIds: [yara.id], mailboxId: box.id })
  }
  const tokenFor = async (sequenceId: string, contactId: string) => {
    const [row] = await owner`select unsubscribe_token from sequence_enrollment where sequence_id = ${sequenceId} and contact_id = ${contactId}`
    return row!.unsubscribe_token as string
  }
  const statesOf = async (contactId: string) =>
    Object.fromEntries(
      (await owner`select s.name, e.state from sequence_enrollment e join sequence s on s.id = e.sequence_id where e.contact_id = ${contactId}`).map(
        (row) => [row.name as string, row.state as string],
      ),
    )
  const unsubscribeEvents = async (contactId: string) =>
    Number(
      (await owner`select count(*)::int as n from sequence_event ev join sequence_enrollment e on e.id = ev.enrollment_id
                    where e.contact_id = ${contactId} and ev.kind = 'unsubscribe'`)[0]?.n,
    )

  check(await unsubscribeByToken(publicScope, await tokenFor(seqA1.id, olive.id)), 'the link from a type works')
  const oliveStates = await statesOf(olive.id)
  check(
    oliveStates[`Verify unsub A1 ${stamp}`] === 'unsubscribed' && oliveStates[`Verify unsub A2 ${stamp}`] === 'unsubscribed',
    'one link stops every enrollment of that type',
    JSON.stringify(oliveStates),
  )
  check(
    oliveStates[`Verify unsub B ${stamp}`] === 'paused',
    'a contact enrolled in a different type is untouched by it',
    oliveStates[`Verify unsub B ${stamp}`] ?? 'missing',
  )
  const [oliveOptA] = await owner`select state from subscription_state where contact_id = ${olive.id} and subscription_type_id = ${optA.id}`
  const [oliveOptB] = await owner`select state from subscription_state where contact_id = ${olive.id} and subscription_type_id = ${optB.id}`
  check(oliveOptA?.state === 'unsubscribed', 'and it writes the opt-out for that type', String(oliveOptA?.state))
  check(oliveOptB === undefined, 'but no opt-out for the other type', String(oliveOptB?.state))

  const eventsBefore = await unsubscribeEvents(olive.id)
  check(
    !(await unsubscribeByToken(publicScope, await tokenFor(seqA1.id, olive.id))),
    'a second use changes nothing',
  )
  check(
    (await unsubscribeEvents(olive.id)) === eventsBefore && eventsBefore === 2,
    'and writes no second round of events',
    `${eventsBefore}`,
  )

  check(await unsubscribeByToken(publicScope, await tokenFor(seqNone.id, yara.id)), 'the link from a sequence with no type works')
  const yaraStates = await statesOf(yara.id)
  check(
    Object.values(yaraStates).every((state) => state === 'unsubscribed'),
    'with no type it stops every enrollment the contact has',
    JSON.stringify(yaraStates),
  )
  const [yaraOpt] = await owner`select state from subscription_state where contact_id = ${yara.id}`
  check(yaraOpt === undefined, 'and records no opt-out, because there is no type to record one against')

  // Turned off on unsubscribe, so the app's own opt-out leaves the enrollment
  // running. The send itself must still refuse.
  const gate = await saveSequence(sales, {
    name: `Verify unsub gate ${stamp}`,
    settings: { ...everyDay, stopOnUnsubscribe: false, subscriptionTypeId: optA.id },
  })
  await saveSteps(sales, {
    sequenceId: gate.id,
    steps: [{ kind: 'email', delayDays: 0, delayHours: 0, subject: 'Hello', bodyText: 'A note.' }],
  })
  await setSequenceState(sales, { id: gate.id, state: 'active' })
  const wren = await createRecord(admin, 'contact', { first_name: 'Wren', last_name: 'Gated', email: `unsub-${stamp}-w@partner1.example` })
  await enroll(sales, { sequenceId: gate.id, contactIds: [wren.id], mailboxId: box.id })
  const [wrenRow] = await listEnrollments(sales, { sequenceId: gate.id })
  await setSubscription(admin, { contactId: wren.id, typeId: optA.id, state: 'unsubscribed' })
  const [wrenAfterRecord] = await owner`select state from sequence_enrollment where id = ${wrenRow!.id}`
  check(wrenAfterRecord?.state === 'active', 'a sequence that does not stop on unsubscribe keeps the enrollment', String(wrenAfterRecord?.state))
  await owner`update sequence_enrollment set next_run_at = now() where id = ${wrenRow!.id}`
  const refusedSend = await claimEnrollmentRun(sales, wrenRow!.id)
  check(
    refusedSend.claimed === null && refusedSend.reason.includes('opted out'),
    'but it does not send to them once they have opted out',
    refusedSend.claimed === null ? refusedSend.reason : 'claimed',
  )
  const [wrenStopped] = await owner`select state from sequence_enrollment where id = ${wrenRow!.id}`
  check(wrenStopped?.state === 'unsubscribed', 'and the enrollment is stopped as unsubscribed', String(wrenStopped?.state))

  const quinn = await createRecord(admin, 'contact', { first_name: 'Quinn', last_name: 'Fresh', email: `unsub-${stamp}-q@partner1.example` })
  const nemo = await createRecord(admin, 'contact', { first_name: 'Nemo', last_name: 'Mail' })
  const named = await enroll(sales, { sequenceId: seqA1.id, contactIds: [olive.id, quinn.id, nemo.id], mailboxId: box.id })
  const nameOf = (contactId: string) => named.find((row) => row.contactId === contactId)
  check(nameOf(quinn.id)?.enrolled === true && nameOf(quinn.id)?.displayName === 'Quinn Fresh', 'an enrolled contact is named in the outcome')
  check(
    nameOf(olive.id)?.enrolled === false && nameOf(olive.id)?.displayName === 'Olive Opted' && reasonOf(nameOf(olive.id))?.includes('opted out') === true,
    'a refused contact is named with the reason',
    JSON.stringify(nameOf(olive.id)),
  )
  check(nameOf(nemo.id)?.displayName === 'Nemo Mail' && nameOf(nemo.id)?.enrolled === false, 'a contact with no address is still named')

  const cora = await createRecord(admin, 'company', { name: `Verify unsub co ${stamp}` })
  await createRecord(admin, 'contact', { first_name: 'Cora', last_name: 'Company', email: `unsub-${stamp}-c@partner1.example`, company_id: cora.id })
  const companyWide = await enroll(sales, { sequenceId: seqNone.id, companyId: cora.id, mailboxId: box.id })
  check(
    companyWide.length === 1 && companyWide[0]?.displayName === 'Cora Company' && companyWide[0]?.enrolled === true,
    'the company-wide enroll names the people it enrolled',
    JSON.stringify(companyWide),
  )

  console.log('')
  console.log('-- reporting ------------------------------------------------------')

  const listed = (await listSequences(sales)).find((row) => row.id === created.id)
  check(listed !== undefined, 'the sequence is listed with its numbers')
  // Three left and one of them bounced. Sent counts all three, the way the report
  // does; the bounce is shown beside it, and it is never an open or a click.
  check(listed?.stats.sent === 3, 'sent counts every mail that left, a bounced one included', String(listed?.stats.sent))
  check(listed?.stats.replied === 1, 'and so are replies', String(listed?.stats.replied))
  check(listed?.stats.bounced === 1, 'and bounces', String(listed?.stats.bounced))
  check(listed?.stats.unsubscribed === 2, 'and opt-outs', String(listed?.stats.unsubscribed))
  const everyone = await listEnrollments(sales, { sequenceId: created.id })
  check(
    listed?.stats.enrolled === everyone.length,
    'enrolled counts everybody who was ever in it, stopped or not',
    `${listed?.stats.enrolled} of ${everyone.length}`,
  )

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

  const trashedCompany = await createRecord(sales, 'company', { name: `Trashed ${stamp}` })
  await createRecord(sales, 'contact', {
    first_name: 'In',
    last_name: 'Trash',
    email: `trash-${stamp}@partner1.example`,
    company_id: trashedCompany.id,
  })
  await deleteRecord(sales, 'company', trashedCompany.id)
  const inTrash = await refused(() =>
    enroll(sales, { sequenceId: created.id, companyId: trashedCompany.id, mailboxId: box.id }),
  )
  check(inTrash?.includes('is in the trash') === true, 'enrolling a company in the trash says so', inTrash ?? 'accepted')

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
  console.log('-- a paused sequence ----------------------------------------------')

  // Four people, each in a state the pause has to meet: enrolled and left alone,
  // parked on a task, paused by hand, and marked active by hand under a paused
  // sequence. Nothing here may send while the sequence is off.
  const [heldA, heldB, heldC, heldD] = await Promise.all(
    ['a', 'b', 'c', 'd'].map((tag) =>
      createRecord(admin, 'contact', { first_name: 'Paused', last_name: tag.toUpperCase(), email: `paused-${tag}-${stamp}@partner1.example` }),
    ),
  )
  await enroll(sales, {
    sequenceId: created.id,
    contactIds: [heldA!.id, heldB!.id, heldC!.id, heldD!.id],
    mailboxId: box.id,
  })
  const rowFor = async (contactId: string) =>
    (await listEnrollments(sales, { sequenceId: created.id })).find((row) => row.contactId === contactId)!
  const [a, b, c, d] = await Promise.all([heldA!, heldB!, heldC!, heldD!].map((p) => rowFor(p.id)))
  const stateOf = async (id: string) => (await listEnrollments(sales, { sequenceId: created.id })).find((row) => row.id === id)?.state

  const dFirst = (await claimEnrollmentRun(sales, d!.id)).claimed
  await recordSend(sales, {
    enrollmentId: d!.id,
    stepId: dFirst!.step!.id,
    mailboxId: box.id,
    providerMessageId: `pm-paused-d-${stamp}`,
    internetMessageId: `<paused-d-${stamp}@sandbox.test>`,
    token: `tok-paused-d-${stamp}`,
    links: [],
    subject: 'Hello',
    contactId: heldD!.id,
  })
  const parkedD = await createStepTask(sales, {
    enrollmentId: d!.id,
    contactId: heldD!.id,
    title: 'Ring them',
    body: null,
    assigneeId: salesUser!.id as string,
  })

  await pauseEnrollment(sales, c!.id)
  await setSequenceState(sales, { id: created.id, state: 'paused' })
  check(
    (await stateOf(a!.id)) === 'paused' && (await stateOf(b!.id)) === 'paused',
    'pausing the sequence pauses who is running in it',
  )
  check((await stateOf(c!.id)) === 'paused', 'a person paused by hand stays paused', await stateOf(c!.id) ?? '')
  check((await stateOf(d!.id)) === 'waiting_task', 'and a person parked on a task is left where they are')

  const resumeA = await refused(() => resumeEnrollment(sales, a!.id))
  check(resumeA === 'Turn the sequence on first.', 'resuming one of them while the sequence is paused is refused', resumeA ?? 'accepted')
  const resumeC = await refused(() => resumeEnrollment(sales, c!.id))
  check(resumeC === 'Turn the sequence on first.', 'and so is resuming one paused by hand', resumeC ?? 'accepted')
  check((await stateOf(c!.id)) === 'paused', 'a refused resume changes nothing', await stateOf(c!.id) ?? '')

  // The row says active while the sequence is paused, which is what a worker
  // would see if the cascade had missed it. The claim must not take it.
  await owner`update sequence_enrollment set state = 'active', next_run_at = now() where id = ${a!.id}::uuid`
  const heldClaim = await claimEnrollmentRun(sales, a!.id)
  check(heldClaim.claimed === null, 'an enrollment marked active under a paused sequence is not claimed', heldClaim.claimed === null ? heldClaim.reason : 'claimed')
  const [heldLease] = await owner`select lease_until from sequence_enrollment where id = ${a!.id}::uuid`
  check(heldLease?.lease_until === null, 'and takes no lease', String(heldLease?.lease_until))

  // Finishing the task under a paused sequence must not start the step.
  await setTaskStatus(sales, parkedD.taskId, 'done')
  check((await stateOf(d!.id)) === 'paused', 'a task finished under a paused sequence leaves the person paused', await stateOf(d!.id) ?? '')

  await setSequenceState(sales, { id: created.id, state: 'active' })
  check((await stateOf(b!.id)) === 'active', 'turning the sequence on resumes the people it paused', await stateOf(b!.id) ?? '')
  check((await stateOf(d!.id)) === 'active', 'and the person whose task was finished under the pause', await stateOf(d!.id) ?? '')

  const bClaim = (await claimEnrollmentRun(sales, b!.id)).claimed
  check(bClaim?.step?.position === 0, 'and once it is on, the first person is claimed and sent to', String(bClaim?.step?.position))
  await recordSend(sales, {
    enrollmentId: b!.id,
    stepId: bClaim!.step!.id,
    mailboxId: box.id,
    providerMessageId: `pm-paused-b-${stamp}`,
    internetMessageId: `<paused-b-${stamp}@sandbox.test>`,
    token: `tok-paused-b-${stamp}`,
    links: [],
    subject: 'Hello',
    contactId: heldB!.id,
  })
  const dClaim = (await claimEnrollmentRun(sales, d!.id)).claimed
  check(dClaim?.step?.position === 2, 'and the one whose task was finished moves on to the step after it', String(dClaim?.step?.position))

  await pauseEnrollment(sales, c!.id)
  await resumeEnrollment(sales, c!.id)
  check((await stateOf(c!.id)) === 'active', 'a resume by hand works once the sequence is on', await stateOf(c!.id) ?? '')

  console.log('')
  console.log('-- archive, restore, copy and delete ----------------------------------')

  const always = { sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59', timezone: 'UTC' } }
  const stateIn = async (sequenceId: string, contactId: string) =>
    (await listEnrollments(sales, { sequenceId })).find((row) => row.contactId === contactId)?.state
  const sequenceState = async (id: string) => (await readSequence(sales, id))?.sequence.state

  const life = await saveSequence(sales, {
    name: `Verify life ${stamp}`,
    description: 'Made for the lifecycle checks.',
    settings: always,
  })
  await saveSteps(sales, {
    sequenceId: life.id,
    steps: [
      { kind: 'email', delayDays: 0, delayHours: 0, subject: 'First {{first_name|there}}', subjectB: 'First, tested', bodyText: 'One.' },
      { kind: 'call', delayDays: 1, delayHours: 0, taskTitle: 'Ring them' },
      { kind: 'email', delayDays: 2, delayHours: 3, subject: 'Third', bodyText: 'Three.' },
    ],
  })
  const lifeA = await createRecord(admin, 'contact', { first_name: 'Life', last_name: 'A', email: `life-${stamp}-a@partner1.example` })
  const lifeB = await createRecord(admin, 'contact', { first_name: 'Life', last_name: 'B', email: `life-${stamp}-b@partner1.example` })

  await enroll(sales, { sequenceId: life.id, contactIds: [lifeA.id], mailboxId: box.id })
  check(
    (await stateIn(life.id, lifeA.id)) === 'paused',
    'a draft takes people in paused, so nothing goes out before it is on',
    (await stateIn(life.id, lifeA.id)) ?? '',
  )
  await setSequenceState(sales, { id: life.id, state: 'active' })
  check((await stateIn(life.id, lifeA.id)) === 'active', 'turning a draft on starts the people already in it')

  await setSequenceState(sales, { id: life.id, state: 'archived' })
  check((await sequenceState(life.id)) === 'archived', 'archiving takes the sequence off the active list')
  check((await stateIn(life.id, lifeA.id)) === 'paused', 'and pauses who is running in it', await stateIn(life.id, lifeA.id) ?? '')
  check(
    (await refused(() => enroll(sales, { sequenceId: life.id, contactIds: [lifeB.id], mailboxId: box.id })))
      === 'That sequence is archived. Restore it to use it again.',
    'and says how to use it again',
  )
  const archivedClaim = await claimEnrollmentRun(sales, (await listEnrollments(sales, { sequenceId: life.id }))[0]!.id)
  check(archivedClaim.claimed === null, 'an archived sequence sends nothing, even to someone it paused')

  await setSequenceState(sales, { id: life.id, state: 'paused' })
  check((await sequenceState(life.id)) === 'paused', 'restoring an archived sequence returns it to paused')
  check((await stateIn(life.id, lifeA.id)) === 'paused', 'and it is still paused until somebody turns it on')
  await setSequenceState(sales, { id: life.id, state: 'active' })
  check((await stateIn(life.id, lifeA.id)) === 'active', 'turning it on after a restore resumes them')

  await setSequenceState(sales, { id: life.id, state: 'archived' })
  await setSequenceState(sales, { id: life.id, state: 'active' })
  check((await stateIn(life.id, lifeA.id)) === 'active', 'turning on straight from archived resumes them too')

  const copy = await cloneSequence(sales, life.id)
  const copied = await readSequence(sales, copy.id)
  check(copied?.sequence.name === `Verify life ${stamp} (copy)`, 'a copy takes the name with a copy suffix', copied?.sequence.name ?? '')
  check(copied?.sequence.state === 'draft', 'and starts as a draft')
  check(copied?.sequence.description === 'Made for the lifecycle checks.', 'with the description kept')
  const stepsOf = (steps: SequenceStep[]) => JSON.stringify(steps.map((step) => ({ ...step, id: undefined })))
  check(
    stepsOf(copied?.steps ?? []) === stepsOf((await readSequence(sales, life.id))?.steps ?? []),
    'with every step copied: order, waits, subjects, bodies and tasks',
  )
  check(isDeepStrictEqual(copied?.sequence.settings.sendWindow, always.sendWindow), 'and the send window')
  check((await listEnrollments(sales, { sequenceId: copy.id })).length === 0, 'and nobody in it')

  const copyTwo = await cloneSequence(sales, life.id)
  check(
    (await readSequence(sales, copyTwo.id))?.sequence.name === `Verify life ${stamp} (copy 2)`,
    'a second copy is numbered rather than refused',
  )

  const wp = await saveSequence(sales, {
    name: `Verify life wp ${stamp}`,
    sender: 'woodpecker',
    settings: { ...always, woodpeckerCampaignId: 4242 },
  })
  const wpCopy = await cloneSequence(sales, wp.id)
  const wpCopied = await readSequence(sales, wpCopy.id)
  check(wpCopied?.sequence.sender === 'woodpecker', 'a copy of a Woodpecker sequence is still a Woodpecker one')
  check(
    wpCopied?.sequence.settings.woodpeckerCampaignId === null,
    'but not its campaign, which would hand the same people over twice',
  )

  const copyName = copied!.sequence.name
  check(
    (await refused(() => saveSequence(sales, { id: life.id, name: '   ' }))) === 'A sequence needs a name.',
    'a rename to nothing is refused',
  )
  check(
    (await refused(() => saveSequence(sales, { id: life.id, name: copyName })))?.includes('already has a sequence called') === true,
    'a rename to a name the account already has is refused in the same words as a create',
  )
  await saveSequence(sales, { id: life.id, name: `  Verify life renamed ${stamp}  ` })
  const renamed = await readSequence(sales, life.id)
  check(renamed?.sequence.name === `Verify life renamed ${stamp}`, 'a rename is trimmed and saved')
  check(renamed?.sequence.description === 'Made for the lifecycle checks.', 'and keeps the description')
  check(renamed?.sequence.state === 'active', 'and keeps the state')
  const sameName = await refused(() => saveSequence(sales, { id: life.id, name: `Verify life renamed ${stamp}` }))
  check(sameName === null, 'a rename to its own name is not a clash', sameName ?? '')

  const viewerRefusals = [
    await refused(() => saveSequence(viewer, { id: life.id, name: 'Viewer name' })),
    await refused(() => cloneSequence(viewer, life.id)),
    await refused(() => deleteSequence(viewer, copy.id)),
  ]
  check(
    viewerRefusals.every((message) => message?.includes('sales') === true),
    'a read-only seat cannot rename, copy or delete',
    viewerRefusals.join(' | '),
  )

  const peerRow = (await owner`select id from account where slug = ${PEER.slug}`)[0]!
  const peer: AccountContext = {
    accountId: peerRow.id as string,
    actorId: await seatFor(peerRow.id as string, PEER.slug),
    actorKind: 'user',
    isSuperAdmin: true,
    viewHubs: [],
    editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
  }
  const notHere = 'That sequence is not in this account.'
  check((await refused(() => saveSequence(peer, { id: life.id, name: 'Hijacked' }))) === notHere, 'another account cannot rename a sequence')
  check((await refused(() => cloneSequence(peer, life.id))) === notHere, 'another account cannot copy one')
  check((await refused(() => deleteSequence(peer, copy.id))) === notHere, 'another account cannot delete one')
  check(
    (await readSequence(sales, life.id))?.sequence.name === `Verify life renamed ${stamp}`,
    'and the sequence is what it was',
  )

  const empty = await saveSequence(sales, { name: `Verify life empty ${stamp}` })
  await deleteSequence(sales, empty.id)
  check((await readSequence(sales, empty.id)) === null, 'a sequence nobody was in is deleted')

  await deleteSequence(sales, copy.id)
  check((await readSequence(sales, copy.id)) === null, 'and so is a copy that was never run')
  const [orphanSteps] = await owner`select count(*)::int as n from sequence_step where sequence_id = ${copy.id}::uuid`
  check(Number(orphanSteps?.n) === 0, 'its steps go with it', String(orphanSteps?.n))

  await enroll(sales, { sequenceId: copyTwo.id, contactIds: [lifeB.id], mailboxId: box.id })
  await removeEnrollment(sales, (await listEnrollments(sales, { sequenceId: copyTwo.id }))[0]!.id)
  const removedBlock = await refused(() => deleteSequence(sales, copyTwo.id))
  check(
    removedBlock?.includes('has had people in it') === true,
    'a sequence with a person removed from it cannot be deleted',
    removedBlock ?? 'deleted',
  )
  check((await readSequence(sales, copyTwo.id)) !== null, 'and it is still there after the refusal')

  const feeder = await saveAutomation(admin, {
    name: `Verify life feeder ${stamp}`,
    trigger: 'record_created',
    objectKey: 'contact',
    conditions: [],
    steps: [{ kind: 'action', type: 'enroll_in_sequence', config: { sequenceId: wpCopy.id, mailboxId: box.id } }],
  })
  const feederBlock = await refused(() => deleteSequence(sales, wpCopy.id))
  check(
    feederBlock === `The automation "Verify life feeder ${stamp}" enrolls people in Verify life wp ${stamp} (copy). Change it before deleting this.`,
    'an automation that enrolls into a sequence blocks its deletion, by name',
    feederBlock ?? 'deleted',
  )
  await owner`delete from automation where id = ${feeder.id}::uuid`
  await deleteSequence(sales, wpCopy.id)
  check((await readSequence(sales, wpCopy.id)) === null, 'and once that automation is gone, the copy can go')

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

  console.log('-- a subscription type a sequence still uses ----------------------')
  const inUse = await createSubscriptionType(admin, { name: `Verify unsub C8 ${stamp}` })
  const replacement = await createSubscriptionType(admin, { name: `Verify unsub C8 next ${stamp}` })
  const c8Sequences: { id: string; name: string }[] = []
  for (const n of [1, 2, 3, 4]) {
    const name = `Verify unsub C8 s${n} ${stamp}`
    c8Sequences.push({ id: (await saveSequence(sales, { name, settings: { ...everyDay, subscriptionTypeId: inUse.id } })).id, name })
  }
  const whileUsed = await refused(() => deleteSubscriptionType(admin, inUse.id, 0))
  check(
    whileUsed?.includes(`Verify unsub C8 s1 ${stamp}, Verify unsub C8 s2 ${stamp}, Verify unsub C8 s3 ${stamp} and 1 more`) === true,
    'a type a sequence points at cannot be deleted, and the message names three and counts the rest',
    whileUsed ?? 'deleted',
  )
  await setSequenceState(admin, { id: c8Sequences[0]!.id, state: 'archived' })
  const whileArchived = await refused(() => deleteSubscriptionType(admin, inUse.id, 0))
  check(whileArchived?.includes('and 1 more') === true, 'an archived sequence still holds the type', whileArchived ?? 'deleted')
  for (const sequence of c8Sequences) {
    await saveSequence(sales, { id: sequence.id, name: sequence.name, settings: { ...everyDay, subscriptionTypeId: replacement.id } })
  }
  const afterRepoint = await refused(() => deleteSubscriptionType(admin, inUse.id, 0))
  check(afterRepoint === null, 'and it can be deleted once no sequence points at it', afterRepoint ?? '')

  console.log('')
  console.log('-- the counts on the list and the editor --------------------------------')

  // Active is who is running or parked on a task. Paused is counted on its own,
  // so a paused sequence shows its people held rather than in flight.
  const countSeq = await saveSequence(sales, {
    name: `Verify counts ${stamp}`,
    description: 'Made for the count checks.',
    settings: always,
  })
  await saveSteps(sales, {
    sequenceId: countSeq.id,
    steps: [
      { kind: 'email', delayDays: 0, delayHours: 0, subject: 'Count {{first_name|there}}', bodyText: 'One.' },
      { kind: 'call', delayDays: 0, delayHours: 0, taskTitle: 'Ring them' },
    ],
  })
  await setSequenceState(sales, { id: countSeq.id, state: 'active' })
  const countPeople = await Promise.all(
    ['a', 'b', 'c'].map((tag) =>
      createRecord(admin, 'contact', { first_name: 'Count', last_name: tag.toUpperCase(), email: `count-${stamp}-${tag}@partner1.example` }),
    ),
  )
  await enroll(sales, { sequenceId: countSeq.id, contactIds: countPeople.map((p) => p!.id), mailboxId: box.id })
  const countRows = await listEnrollments(sales, { sequenceId: countSeq.id })
  const countId = (contactId: string) => countRows.find((row) => row.contactId === contactId)!.id
  await pauseEnrollment(sales, countId(countPeople[1]!.id))
  const parkedC = await claimEnrollmentRun(sales, countId(countPeople[2]!.id))
  await recordSend(sales, {
    enrollmentId: countId(countPeople[2]!.id),
    stepId: parkedC.claimed!.step!.id,
    mailboxId: box.id,
    providerMessageId: `pm-count-c-${stamp}`,
    internetMessageId: `<count-c-${stamp}@sandbox.test>`,
    token: `tok-count-c-${stamp}`,
    links: [],
    subject: 'Count',
    contactId: countPeople[2]!.id,
  })
  await createStepTask(sales, {
    enrollmentId: countId(countPeople[2]!.id),
    contactId: countPeople[2]!.id,
    title: 'Ring them',
    body: null,
    assigneeId: salesUser!.id as string,
  })
  const countsOf = async () => (await readSequence(sales, countSeq.id))!.sequence.stats
  const listedCounts = async () => (await listSequences(sales)).find((row) => row.id === countSeq.id)?.stats
  const beforePause = await countsOf()
  check(beforePause.active === 2 && beforePause.paused === 1, 'a running person and one parked on a task are active, the one paused by hand is not', `active ${beforePause.active}, paused ${beforePause.paused}`)
  check((await listedCounts())?.active === 2 && (await listedCounts())?.paused === 1, 'the sequence list counts the same way as the editor', `active ${(await listedCounts())?.active}, paused ${(await listedCounts())?.paused}`)

  await setSequenceState(sales, { id: countSeq.id, state: 'paused' })
  const afterPause = await countsOf()
  check(afterPause.paused === 2 && afterPause.active === 1, 'pausing the sequence moves the running person to paused, and the parked one stays active', `active ${afterPause.active}, paused ${afterPause.paused}`)

  console.log('')
  // Everything this script made goes with it.
  await withAccount(admin, async (tx) => {
    await tx.execute(sql`delete from sequence where id = ${created.id}::uuid`)
  })
  await owner`delete from subscription_state where subscription_type_id in (select id from subscription_type where name like ${`Verify unsub % ${stamp}`})`
  await owner`delete from subscription_type where name like ${`Verify unsub % ${stamp}`}`
  await owner`delete from sequence where name like ${`Verify unsub % ${stamp}`}`
  await owner`delete from message_thread where provider_thread_id like ${`%-${stamp}`}`
  await owner`delete from mailbox where id in (${box.id}, ${readOnlyBox!.id})`
  await owner`delete from automation where name like ${`Verify life%${stamp}%`}`
  await owner`delete from sequence where name like ${`Verify life%${stamp}%`}`
  await owner`delete from sequence where name = ${`Verify counts ${stamp}`}`
  await owner`delete from contact where account_id = ${accountId} and (email like ${`life-${stamp}-%`} or email like ${`seq-${stamp}%`} or email like ${`auto-${stamp}%`} or email like ${`bounce-${stamp}%`} or email like ${`opt-${stamp}%`} or email like ${`record-opt-${stamp}%`} or email like ${`orphan-${stamp}%`} or email like ${`unsub-${stamp}-%`} or email like ${`lost-${stamp}%`} or email like ${`paced-${stamp}%`} or email like ${`quiet-${stamp}%`} or email like ${`paused-%-${stamp}@%`} or email like ${`count-${stamp}-%`} or (first_name = 'Lost' and last_name = 'Address') or (first_name = 'No' and last_name = 'Address') or (first_name = 'Nemo' and last_name = 'Mail'))`
  await owner`delete from company where name = ${`Verify unsub co ${stamp}`}`
} finally {
  await Promise.all([owner.end(), closeAppPool()])
  await cleanup()
}

if (failures.length) {
  console.error(`\n${failures.length} sequence check(s) failed.`)
  process.exit(1)
}
console.log('\nall sequence checks passed.')
