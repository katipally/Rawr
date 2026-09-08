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
  enroll,
  listEnrollments,
  listSequences,
  readSequence,
  recordClick,
  recordOpen,
  recordSend,
  saveSequence,
  saveSteps,
  setSequenceState,
  unsubscribeByToken,
} from '../src/dal/sequences.ts'
import { SANDBOX } from './fixture.ts'

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
  const withSteps = await readSequence(sales, created.id)
  check(withSteps?.steps.length === 3, 'the steps are saved in order', `${withSteps?.steps.length ?? 0}`)
  check(withSteps?.steps[1]?.kind === 'call', 'and keep the order they were given', withSteps?.steps[1]?.kind ?? '')

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

  const claim = await claimEnrollmentRun(sales, enrollment!.id)
  check(claim !== null, 'the scheduler can claim it')
  check(claim?.step?.position === 0, 'and is handed the step it is on', String(claim?.step?.position))
  check(claim?.contactEmail === `seq-${stamp}@partner1.example`, 'with everything the send needs')

  const second = await claimEnrollmentRun(sales, enrollment!.id)
  check(second === null, 'a second worker cannot claim the same run')

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
  const autoClaim = await claimEnrollmentRun(sales, autoEnrollment!.id)
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
  const bounceClaim = await claimEnrollmentRun(sales, bounceEnrollment!.id)
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

  // Everything this script made goes with it.
  await withAccount(admin, async (tx) => {
    await tx.execute(sql`delete from sequence where id = ${created.id}::uuid`)
  })
  await owner`delete from message_thread where provider_thread_id like ${`%-${stamp}`}`
  await owner`delete from mailbox where id in (${box.id}, ${readOnlyBox!.id})`
  await owner`delete from contact where account_id = ${accountId} and (email like ${`seq-${stamp}%`} or email like ${`auto-${stamp}%`} or email like ${`bounce-${stamp}%`} or email like ${`opt-${stamp}%`} or email like ${`record-opt-${stamp}%`} or (first_name = 'No' and last_name = 'Address'))`
} finally {
  await Promise.all([owner.end(), closeAppPool()])
}

if (failures.length) {
  console.error(`\n${failures.length} sequence check(s) failed.`)
  process.exit(1)
}
console.log('\nall sequence checks passed.')
