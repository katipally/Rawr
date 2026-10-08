import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import type { AccountContext } from '../src/dal/context.ts'
import { readTimeline, timelineCounts } from '../src/dal/activity.ts'
import { withAccount } from '../src/dal/index.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import {
  bodyProgress,
  disconnectMailbox,
  failBody,
  ingestMessage,
  inboxCounts,
  internalDomainOf,
  listInboxThreads,
  markMailboxCannotModify,
  markThreadRead,
  pendingBodies,
  readThread,
  recordMailboxFailure,
  saveMailbox,
  setMailboxVisibility,
  storeBody,
  TEXT_LIMIT_BYTES,
  updateMailboxCursor,
  attachContactToMail,
  threadsForContact,
  type IncomingMessage,
} from '../src/dal/messages.ts'
import { createRecord, mergeRecords } from '../src/dal/records.ts'
import { acknowledgeThreadPush, changeThread, reconcileThreadFolders, threadPushPlan } from '../src/dal/thread-state.ts'
import { SANDBOX, cleanup } from './fixture.ts'

/** What B3 added: bodies kept here rather than fetched from somebody's mailbox,
 *  a sharing rule enforced in SQL, and a shared inbox.
 *
 *  The point of every check below is the same one: correspondence has to outlive
 *  the mailbox that brought it in, without becoming readable by people who were
 *  never meant to see it. */

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

  const person = async (email: string) => {
    const [row] = await owner`select id, email, name from user_account where email = ${email}`
    if (!row) throw new Error(`no seeded user ${email}`)
    return row as { id: string; email: string; name: string }
  }
  const salesUser = await person('sales@sandbox.test')
  const marketingUser = await person('marketing@sandbox.test')
  const adminUser = await person('admin@sandbox.test')

  const ctxFor = (userId: string, editHubs: string[]): AccountContext => ({
    accountId,
    actorId: userId,
    actorKind: 'user',
    isSuperAdmin: editHubs.includes('account'),
    viewHubs: [],
    editHubs: editHubs as AccountContext['editHubs'],
  })
  const sales = ctxFor(salesUser.id, ['contacts', 'sales'])
  const marketing = ctxFor(marketingUser.id, ['contacts', 'marketing'])
  const admin = ctxFor(adminUser.id, ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'])

  const internalDomain = await internalDomainOf(sales)

  const box = await saveMailbox(sales, {
    userId: salesUser.id,
    email: salesUser.email,
    accessToken: `access-${stamp}`,
    refreshToken: `refresh-${stamp}`,
    accessTokenExpiresAt: null,
  })

  const incoming = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
    providerThreadId: `mail-t-${stamp}`,
    providerMessageId: `mail-m-${stamp}`,
    subject: 'Trial questions',
    from: `body-${stamp}@partner1.example`,
    to: [salesUser.email],
    cc: [],
    sentAt: new Date(),
    snippet: 'Only the first line.',
    internetMessageId: `<mail-m-${stamp}@partner1.example>`,
    hasAttachments: false,
    ...over,
  })

  console.log('-- bodies ----------------------------------------------------------')

  const withBody = await ingestMessage(sales, {
    incoming: incoming({
      body: { text: 'The whole message.', html: '<p>The whole <b>message</b>.</p>' },
      attachments: [
        { filename: 'pricing.pdf', mimeType: 'application/pdf', sizeBytes: 2048, providerAttachmentId: 'a1', inline: false },
      ],
    }),
    ownerEmail: salesUser.email,
    mailboxId: box.id,
    internalDomain,
    blocked: new Set(),
  })
  check(withBody.stored, 'a message with a body is stored')
  const threadId = withBody.stored ? withBody.threadId : ''

  const read = await readThread(sales, threadId)
  const first = read?.messages[0]
  check(first?.text === 'The whole message.', 'the body is read back from here, not from Gmail', first?.bodyState ?? '')
  check(first?.html?.includes('<b>message</b>') === true, 'the formatted version is kept alongside the text')
  check(first?.attachments.length === 1, 'attachments are listed', `${first?.attachments.length ?? 0}`)

  const headers = await owner`
    select internet_message_id from message where provider_message_id = ${`mail-m-${stamp}`}`
  check(
    headers[0]?.internet_message_id === `<mail-m-${stamp}@partner1.example>`,
    'the Message-ID is kept, which is what a reply is matched against',
  )

  // A message read without its body is queued rather than lost.
  const later = await ingestMessage(sales, {
    incoming: incoming({ providerMessageId: `mail-m2-${stamp}`, subject: 'Re: Trial questions' }),
    ownerEmail: salesUser.email,
    mailboxId: box.id,
    internalDomain,
    blocked: new Set(),
  })
  check(later.stored, 'a message read without its body is still stored')

  const queue = await pendingBodies(sales, box.id, 10)
  check(queue.length === 1, 'and it is in the hydrate queue', `${queue.length} waiting`)

  await storeBody(sales, queue[0]!.id, { text: 'Fetched afterwards.' })
  const hydrated = await readThread(sales, threadId)
  check(
    hydrated?.messages.some((message) => message.text === 'Fetched afterwards.') === true,
    'hydrating fills it in without touching the message row',
  )

  const progress = await bodyProgress(sales)
  const mine = progress.find((row) => row.mailboxId === box.id)
  check(mine !== undefined && mine.pending === 0, 'the queue drains to nothing', `${mine?.pending ?? '?'} left`)

  // Oversized text is cut and says so; the message is never dropped.
  const huge = await ingestMessage(sales, {
    incoming: incoming({
      providerThreadId: `mail-huge-${stamp}`,
      providerMessageId: `mail-huge-m-${stamp}`,
      subject: 'A very long mail',
      body: { text: 'x'.repeat(TEXT_LIMIT_BYTES + 5_000) },
    }),
    ownerEmail: salesUser.email,
    mailboxId: box.id,
    internalDomain,
    blocked: new Set(),
  })
  const hugeThread = huge.stored ? await readThread(sales, huge.threadId) : null
  const hugeMessage = hugeThread?.messages[0]
  check(hugeMessage?.truncated === true, 'an oversized body is truncated rather than refused')
  check(hugeMessage?.bodyState === 'too_large', 'and the state says why', hugeMessage?.bodyState ?? '')

  await failBody(sales, queue[0]!.id, 'The mailbox is gone.')
  const failedThread = await readThread(sales, threadId)
  check(
    failedThread?.messages.some((message) => message.bodyState === 'failed') === true,
    'a body that cannot be fetched is marked, so the queue drains',
  )
  await storeBody(sales, queue[0]!.id, { text: 'Fetched afterwards.' })

  console.log('')
  console.log('-- who may read it -------------------------------------------------')

  check((await readThread(marketing, threadId)) === null, 'a newly connected mailbox is private until its owner shares it')
  await setMailboxVisibility(sales, { mailboxId: box.id, visibility: 'team' })
  const sharedForMarketing = await readThread(marketing, threadId)
  check(sharedForMarketing !== null, 'a shared mailbox is readable by a colleague')

  const contactId = withBody.stored ? withBody.contactIds[0]! : ''
  const contactRef = { entityType: 'contact' as const, entityId: contactId }
  // This thread's rows only: the contact is one a colleague's earlier mail also hangs on.
  const timelineHas = async (ctx: AccountContext) =>
    (await readTimeline(ctx, { entity: contactRef, types: ['email'], limit: 200 })).rows.filter(
      (row) => (row.payload as { threadId?: string } | null)?.threadId === threadId,
    ).length
  const sharedCount = (await timelineCounts(marketing, contactRef)).email ?? 0
  const sharedTimeline = await timelineHas(marketing)
  check(contactId !== '' && sharedTimeline > 0, 'a shared mailbox puts its mail on the contact timeline', `${sharedTimeline} rows`)
  check((await threadsForContact(marketing, contactId)).some((thread) => thread.id === threadId), 'and its threads on the record')

  await setMailboxVisibility(sales, { mailboxId: box.id, visibility: 'private' })
  check((await readThread(marketing, threadId)) === null, 'a private mailbox is not')
  check((await timelineHas(marketing)) === 0, 'its mail is off a colleague’s timeline too, not only out of the inbox')
  check(((await timelineCounts(marketing, contactRef)).email ?? 0) < sharedCount, 'and out of the timeline counts')
  check(!(await threadsForContact(marketing, contactId)).some((thread) => thread.id === threadId), 'and out of the threads on the record')
  check((await timelineHas(sales)) === sharedTimeline, 'its owner still reads it on the timeline')
  check((await timelineHas(admin)) === sharedTimeline, 'and so does an admin')
  check((await readThread(sales, threadId)) !== null, 'its owner still reads it')
  check((await readThread(admin, threadId)) !== null, 'and so does an admin')

  const threadRows = (ctx: AccountContext) =>
    withAccount(ctx, async (tx) => (await tx.execute(sql`select id from message_thread where id = ${threadId}`)).length)
  check((await threadRows(marketing)) === 0, 'the thread row itself, its subject and dates, is hidden with its mail')
  check((await threadRows(sales)) === 1 && (await threadRows(admin)) === 1, 'and still read by its owner and by an admin')

  await markThreadRead(sales, threadId)
  const markers = (ctx: AccountContext) =>
    withAccount(ctx, async (tx) => (await tx.execute(sql`select 1 from message_thread_read where thread_id = ${threadId}`)).length)
  check((await markers(sales)) === 1 && (await markers(admin)) === 0, 'how far somebody has read a thread is read by that person alone, an admin included')

  const hiddenInbox = await listInboxThreads(marketing, {})
  check(
    !hiddenInbox.threads.some((thread) => thread.id === threadId),
    'a private thread is absent from a colleague’s inbox as well as from the record',
  )

  // Two private mailboxes on one conversation: the second one's sync must store
  // its message onto the thread it cannot yet read, and then read it.
  const second = await saveMailbox(marketing, {
    userId: marketingUser.id,
    email: marketingUser.email,
    accessToken: `access-m-${stamp}`,
    refreshToken: `refresh-m-${stamp}`,
    accessTokenExpiresAt: null,
  })
  const joined = await ingestMessage(marketing, {
    incoming: incoming({ providerMessageId: `mail-m3-${stamp}`, subject: 'Re: Trial questions', to: [marketingUser.email] }),
    ownerEmail: marketingUser.email,
    mailboxId: second.id,
    internalDomain,
    blocked: new Set(),
  })
  check(joined.stored && joined.threadId === threadId, 'a second private mailbox stores its message onto the same thread')
  check((await threadRows(marketing)) === 1, 'and then reads the thread through its own mail')
  await disconnectMailbox(marketing, second.id)

  const notYours = await refused(() =>
    setMailboxVisibility(marketing, { mailboxId: box.id, visibility: 'team' }),
  )
  check(notYours?.includes('somebody else') === true, 'somebody else cannot share your mailbox', notYours ?? '')

  await setMailboxVisibility(admin, { mailboxId: box.id, visibility: 'team' })
  check((await readThread(marketing, threadId)) !== null, 'an admin can share it back')

  console.log('')
  console.log('-- after the mailbox is gone ---------------------------------------')

  await disconnectMailbox(sales, box.id)
  const orphaned = await readThread(marketing, threadId)
  check(
    orphaned?.messages[0]?.text === 'The whole message.',
    'the correspondence is still readable once the mailbox that read it is disconnected',
  )

  console.log('')
  console.log('-- the shared inbox ------------------------------------------------')

  const inbox = await listInboxThreads(sales, { limit: 50 })
  const listed = inbox.threads.find((thread) => thread.id === threadId)
  check(listed !== undefined, 'the thread is in the inbox')
  check(listed?.lastDirection === 'inbound', 'the newest message decides whether it is waiting on us')
  check(listed?.unread === true, 'and it is unread until somebody opens it')

  await markThreadRead(sales, threadId)
  const afterRead = await listInboxThreads(sales, { limit: 50 })
  check(
    afterRead.threads.find((thread) => thread.id === threadId)?.unread === false,
    'marking it read is per person',
  )
  const forMarketing = await listInboxThreads(marketing, { limit: 50 })
  check(
    forMarketing.threads.find((thread) => thread.id === threadId)?.unread === true,
    'and does not clear it for anybody else',
  )

  const unrepliedOnly = await listInboxThreads(sales, { unreplied: true, limit: 50 })
  check(
    unrepliedOnly.threads.every((thread) => thread.lastDirection === 'inbound'),
    'the waiting-on-us filter shows only threads whose newest message came in',
  )

  // Our reply is the last real message; an out-of-office after it must not put the thread back on us.
  const awayBox = await saveMailbox(sales, {
    userId: salesUser.id,
    email: salesUser.email,
    accessToken: `access-away-${stamp}`,
    refreshToken: `refresh-away-${stamp}`,
    accessTokenExpiresAt: null,
  })
  const awayThread = `mail-away-t-${stamp}`
  const awayAddr = `away-${stamp}@partner1.example`
  const awayIn = (over: Partial<IncomingMessage>) =>
    ingestMessage(sales, {
      incoming: incoming({ providerThreadId: awayThread, subject: 'Pricing', from: awayAddr, to: [salesUser.email], ...over }),
      ownerEmail: salesUser.email,
      mailboxId: awayBox.id,
      internalDomain,
      blocked: new Set(),
    })
  await awayIn({ providerMessageId: `mail-away1-${stamp}`, sentAt: new Date(Date.now() - 180_000) })
  await awayIn({
    providerMessageId: `mail-away2-${stamp}`,
    from: salesUser.email,
    to: [awayAddr],
    subject: 'Re: Pricing',
    sentAt: new Date(Date.now() - 120_000),
  })
  const waitingBefore = (await inboxCounts(sales)).unreplied
  await awayIn({
    providerMessageId: `mail-away3-${stamp}`,
    subject: 'Out of Office',
    headers: { 'auto-submitted': 'auto-replied' },
    sentAt: new Date(Date.now() - 60_000),
  })
  const waitingAfter = (await inboxCounts(sales)).unreplied
  check(waitingAfter === waitingBefore, 'an out-of-office after our reply leaves the unreplied count alone', `${waitingBefore} then ${waitingAfter}`)
  const awayWaiting = await listInboxThreads(sales, { unreplied: true, limit: 50 })
  check(!awayWaiting.threads.some((thread) => thread.id === awayThread), 'and the waiting-on-us filter does not list that thread')

  const searched = await listInboxThreads(sales, { q: 'Trial questions', limit: 50 })
  check(searched.threads.some((thread) => thread.id === threadId), 'search matches a subject')
  const missing = await listInboxThreads(sales, { q: `nothing-${stamp}`, limit: 50 })
  check(missing.threads.length === 0, 'and matches nothing when nothing matches')
  const anyOrder = await listInboxThreads(sales, { q: 'questions trial', limit: 50 })
  check(anyOrder.threads.some((thread) => thread.id === threadId), 'the words of an inbox search match in any order')
  const midWord = await listInboxThreads(sales, { q: 'stions tri', limit: 50 })
  check(midWord.threads.some((thread) => thread.id === threadId), 'an inbox search fragment matches mid-word')
  const literalPercent = await listInboxThreads(sales, { q: 'Trial%', limit: 50 })
  check(!literalPercent.threads.some((thread) => thread.id === threadId), 'a percent sign in the inbox search matches itself, not any text')
  const oneWordMissing = await listInboxThreads(sales, { q: `trial nothing-${stamp}`, limit: 50 })
  check(!oneWordMissing.threads.some((thread) => thread.id === threadId), 'an inbox search with one word that matches nothing still matched')

  const firstPage = await listInboxThreads(sales, { limit: 1 })
  const secondPage = firstPage.cursor
    ? await listInboxThreads(sales, { limit: 1, cursor: firstPage.cursor })
    : { threads: [] }
  check(
    !secondPage.threads.some((thread) => firstPage.threads.some((seen) => seen.id === thread.id)),
    'the keyset page does not repeat a thread it already showed',
  )

  console.log('-- a failing mailbox -------------------------------------------------')

  const brokenBox = await saveMailbox(sales, {
    userId: salesUser.id,
    email: salesUser.email,
    accessToken: `access-fail-${stamp}`,
    refreshToken: `refresh-fail-${stamp}`,
    accessTokenExpiresAt: null,
  })
  const standing = async () =>
    (await owner`select state, failures, last_error from mailbox where id = ${brokenBox.id}`)[0] as {
      state: string
      failures: number
      last_error: string | null
    }
  await recordMailboxFailure(sales, brokenBox.id, 'Gmail answered 503', false)
  await recordMailboxFailure(sales, brokenBox.id, 'Gmail answered 503', false)
  const failing = await standing()
  check(failing.state === 'error' && failing.failures === 2, 'each failed pass counts, so a retry can be spaced out', `${failing.state} ${failing.failures}`)
  await updateMailboxCursor(sales, brokenBox.id, { state: 'backfilling' })
  const recovered = await standing()
  check(recovered.state === 'backfilling' && recovered.failures === 0 && recovered.last_error === null, 'a pass that works ends the error state and the count')
  await recordMailboxFailure(sales, brokenBox.id, 'Access withdrawn', true)
  check((await standing()).state === 'revoked', 'a withdrawal is still stopped, not retried')

  console.log('-- a re-created contact takes its mail -------------------------------')

  const returning = `returning-${stamp}@partner2.example`
  const original = await createRecord(sales, 'contact', { first_name: 'Old', last_name: 'Contact', email: returning })
  const returningBox = await saveMailbox(sales, {
    userId: salesUser.id,
    email: salesUser.email,
    accessToken: `access-returning-${stamp}`,
    refreshToken: `refresh-returning-${stamp}`,
    accessTokenExpiresAt: null,
  })
  const mailed = await ingestMessage(sales, {
    incoming: incoming({
      providerThreadId: `mail-r-${stamp}`,
      providerMessageId: `mail-r-${stamp}`,
      from: returning,
      internetMessageId: `<mail-r-${stamp}@partner2.example>`,
    }),
    ownerEmail: salesUser.email,
    mailboxId: returningBox.id,
    internalDomain,
    blocked: new Set(),
  })
  check(mailed.stored && mailed.contactIds.includes(original.id), 'mail from a contact is stored on that contact')
  await owner`update contact set deleted_at = now() where id = ${original.id}`
  const replacement = await createRecord(sales, 'contact', { first_name: 'New', last_name: 'Contact', email: returning })
  const attached = await attachContactToMail(sales, replacement.id)
  const [rows] = await owner<{ total: number; pointing: number }[]>`
    select count(*)::int as total, count(*) filter (where contact_id = ${replacement.id})::int as pointing
      from message_participant where address = ${returning}`
  check(attached.messages === 1, 'the re-created contact gets the one message it was sent', `${attached.messages} messages`)
  check(rows?.total === 1 && rows.pointing === 1, 'the address row now points at the new contact', `${rows?.pointing ?? 0} of ${rows?.total ?? 0}`)

  console.log('-- mail finds a company by its alias ----------------------------------')

  const makeCompany = (name: string, domain: string) => createRecord(sales, 'company', { name: `${name} ${stamp}`, domain })
  const filedUnder = async (from: string, tag: string): Promise<string | null> => {
    const result = await ingestMessage(sales, {
      incoming: incoming({
        providerThreadId: `mail-${tag}-${stamp}`,
        providerMessageId: `mail-${tag}-${stamp}`,
        from,
        internetMessageId: `<mail-${tag}-${stamp}@mail.example>`,
      }),
      ownerEmail: salesUser.email,
      mailboxId: returningBox.id,
      internalDomain,
      blocked: new Set(),
    })
    if (!result.stored) return null
    const [row] = await owner<{ company_id: string | null }[]>`select company_id from contact where email = ${from}`
    return row?.company_id ?? null
  }

  const survivor = await makeCompany('Mail merge', `mergekept${stamp}.example`)
  const absorbed = await makeCompany('Mail merge absorbed', `mergegone${stamp}.example`)
  await mergeRecords(sales, { objectKey: 'company', survivorId: survivor.id, absorbedId: absorbed.id, picks: {} })
  const aliasFiled = await filedUnder(`old.${stamp}@mergegone${stamp}.example`, 'alias')
  check(aliasFiled === survivor.id, 'mail from an absorbed company’s old domain is filed under the survivor', `${aliasFiled ?? 'nothing'}`)

  const trashed = await makeCompany('Mail trashed', `mailtrash${stamp}.example`)
  await owner`update company set deleted_at = now() where id = ${trashed.id}`
  const trashedFiled = await filedUnder(`gone.${stamp}@mailtrash${stamp}.example`, 'trashed')
  check(trashedFiled === null, 'mail from a trashed company’s domain is not filed under it', `${trashedFiled ?? 'nothing'}`)

  const primary = await makeCompany('Mail primary', `mailwon${stamp}.example`)
  const holder = await makeCompany('Mail alias holder', `mailheld${stamp}.example`)
  await owner`insert into company_domain (account_id, company_id, domain) values (${accountId}, ${holder.id}, ${`mailwon${stamp}.example`})`
  const primaryFiled = await filedUnder(`win.${stamp}@mailwon${stamp}.example`, 'primary')
  check(primaryFiled === primary.id, 'a primary domain beats an alias on the same domain', `${primaryFiled ?? 'nothing'}`)

  console.log('-- inbox folders and Gmail sync ----------------------------------------')

  // The mailbox above was disconnected earlier, which takes its messages off it. A fresh
  // connection and thread give these checks a mailbox that is really holding mail.
  const live = await saveMailbox(sales, {
    userId: salesUser.id,
    email: salesUser.email,
    accessToken: `access-${stamp}`,
    refreshToken: `refresh-${stamp}`,
    accessTokenExpiresAt: null,
    canModify: true,
  })
  const threadKey = `mail-t2-${stamp}`
  const folderMail = await ingestMessage(sales, {
    incoming: incoming({ providerThreadId: threadKey, providerMessageId: `mail-fold-${stamp}` }),
    ownerEmail: salesUser.email,
    mailboxId: live.id,
    internalDomain,
    blocked: new Set(),
  })
  const thread = folderMail.stored ? folderMail.threadId : ''
  check(thread !== '', 'a fresh mailbox stores its mail on a thread the checks can use')
  const folderRow = async () =>
    (
      await owner<{ archived_at: Date | null; trashed_at: Date | null; assigned_to: string | null; state_changed_at: Date | null; gmail_synced_at: Date | null }[]>`
        select archived_at, trashed_at, assigned_to, state_changed_at, gmail_synced_at from message_thread where id = ${thread}`
    )[0]!
  const inFolder = async (ctx: AccountContext, folder: 'inbox' | 'archived' | 'trash', assignedToMe = false) =>
    (await listInboxThreads(ctx, { mailboxId: live.id, folder, assignedToMe, limit: 100 })).threads.map((row) => row.id)

  await changeThread(sales, thread, { kind: 'archived', value: true })
  let row = await folderRow()
  check(row.archived_at !== null && row.gmail_synced_at === null, 'archiving records the change and leaves it waiting for Gmail', `${row.gmail_synced_at}`)
  check(!(await inFolder(sales, 'inbox')).includes(thread), 'an archived thread leaves the Inbox')
  check((await inFolder(sales, 'archived')).includes(thread), 'an archived thread shows in Archive')

  await changeThread(sales, thread, { kind: 'archived', value: false })
  check((await folderRow()).archived_at === null, 'moving back to the Inbox clears the archive')

  await changeThread(sales, thread, { kind: 'trashed', value: true })
  check((await inFolder(sales, 'trash')).includes(thread) && !(await inFolder(sales, 'inbox')).includes(thread), 'a deleted thread shows in Trash, not the Inbox')
  await changeThread(sales, thread, { kind: 'trashed', value: false })
  check((await folderRow()).trashed_at === null, 'restoring from Trash clears the trash mark')

  await changeThread(sales, thread, { kind: 'assignee', value: salesUser.id })
  check((await folderRow()).assigned_to === salesUser.id, 'assigning a thread records the teammate')
  check((await inFolder(sales, 'inbox', true)).includes(thread), '“Assigned to me” lists the thread for its assignee')
  const notMember = await refused(() => changeThread(sales, thread, { kind: 'assignee', value: '00000000-0000-4000-8000-00000000beef' }))
  check(notMember !== null, 'a thread cannot be assigned to somebody outside the account', `${notMember ?? 'no error'}`)
  await changeThread(sales, thread, { kind: 'assignee', value: null })
  check((await folderRow()).assigned_to === null, 'unassigning clears the teammate')

  await setMailboxVisibility(sales, { mailboxId: live.id, visibility: 'private' })
  const hidden = await refused(() => changeThread(marketing, thread, { kind: 'archived', value: true }))
  check(hidden !== null && (await folderRow()).archived_at === null, 'a member who cannot see a private mailbox cannot archive its thread', `${hidden ?? 'no error'}`)

  await changeThread(sales, thread, { kind: 'unread', value: true })
  const unreadRead = await readThread(sales, thread)
  check(unreadRead?.thread.unread === true, 'marking unread shows the thread unread to its reader')
  await markThreadRead(sales, thread)
  const folderAfterRead = await readThread(sales, thread)
  check(folderAfterRead?.thread.unread === false, 'reading the thread again clears the unread mark')

  // Rawr's change is waiting for Gmail: a Gmail read taken before it must not win, and
  // the same read taken after it must not win until Gmail has the change.
  await changeThread(sales, thread, { kind: 'archived', value: true })
  row = await folderRow()
  const changedAt = row.state_changed_at as Date
  await reconcileThreadFolders(sales, threadKey, { archived: false, trashed: false }, new Date(changedAt.getTime() + 1000))
  check((await folderRow()).archived_at !== null, 'a Gmail read cannot undo an archive Rawr has not sent yet')

  const plan = await threadPushPlan(sales, thread)
  check(plan?.providerThreadId === threadKey && plan.archived && plan.version?.getTime() === changedAt.getTime(), 'the push plan carries the change it will send')
  await acknowledgeThreadPush(sales, thread, changedAt)
  row = await folderRow()
  check(row.gmail_synced_at?.getTime() === changedAt.getTime(), 'a delivered change is acknowledged')

  await reconcileThreadFolders(sales, threadKey, { archived: false, trashed: false }, new Date(changedAt.getTime() - 1000))
  check((await folderRow()).archived_at !== null, 'a Gmail read older than the last change is ignored')
  await reconcileThreadFolders(sales, threadKey, { archived: false, trashed: false }, new Date(changedAt.getTime() + 1000))
  check((await folderRow()).archived_at === null, 'a Gmail read taken after the change, once it is delivered, is taken as Gmail’s view')

  await saveMailbox(sales, {
    userId: salesUser.id,
    email: salesUser.email,
    accessToken: `access-${stamp}`,
    refreshToken: `refresh-${stamp}`,
    accessTokenExpiresAt: null,
    canModify: false,
  })
  const gaps = (await readThread(sales, thread))?.gmailGaps ?? []
  check(gaps.some((gap) => gap.id === live.id), 'a mailbox without gmail.modify is named on the thread')
  await changeThread(sales, thread, { kind: 'archived', value: false })
  await acknowledgeThreadPush(sales, thread, (await folderRow()).state_changed_at as Date)
  await saveMailbox(sales, {
    userId: salesUser.id,
    email: salesUser.email,
    accessToken: `access-${stamp}`,
    refreshToken: `refresh-${stamp}`,
    accessTokenExpiresAt: null,
    canModify: true,
  })
  row = await folderRow()
  check(row.gmail_synced_at?.getTime() !== row.state_changed_at?.getTime(), 'reconnecting with gmail.modify queues the changes the mailbox missed')
  check((await readThread(sales, thread))?.gmailGaps.every((gap) => gap.id !== live.id) === true, 'the reconnect clears the gap on the thread')
  check((await threadPushPlan(sales, thread))?.mailboxes.some((holder) => holder.id === live.id && holder.canModify) === true, 'the push plan can reach the reconnected mailbox')
  await markMailboxCannotModify(sales, live.id)
  check((await threadPushPlan(sales, thread))?.mailboxes.some((holder) => holder.id === live.id && !holder.canModify) === true, 'a Google refusal turns the mailbox into one that cannot change Gmail')

  const counts = await inboxCounts(sales)
  check(typeof counts.archived === 'number' && typeof counts.trash === 'number' && typeof counts.assignedToMe === 'number', 'the inbox counts carry the folders and the assignee')

  // Everything this script made goes with it.
  await withAccount(admin, async (tx) => {
    await tx.execute(sql`delete from message_thread where provider_thread_id like ${`mail-%${stamp}`}`)
  })
  await owner`delete from message_thread where provider_thread_id like ${`mail-%-${stamp}`}`
  await owner`delete from mailbox where id in (${box.id}, ${brokenBox.id}, ${returningBox.id}, ${live.id})`
  await owner`delete from contact where account_id = ${accountId} and email like ${`body-${stamp}%`}`
  await owner`delete from contact where account_id = ${accountId} and email = ${returning}`
  await owner`delete from contact where account_id = ${accountId} and email like ${`%${stamp}%`}`
  await owner`delete from company where account_id = ${accountId} and name like ${`%${stamp}%`}`
} finally {
  await Promise.all([owner.end(), closeAppPool()])
  await cleanup()
}

if (failures.length) {
  console.error(`\n${failures.length} mail check(s) failed.`)
  process.exit(1)
}
console.log('\nall mail checks passed.')
