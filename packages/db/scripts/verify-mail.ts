import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import type { AccountContext } from '../src/dal/context.ts'
import { withAccount } from '../src/dal/index.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import {
  bodyProgress,
  disconnectMailbox,
  failBody,
  ingestMessage,
  internalDomainOf,
  listInboxThreads,
  markThreadRead,
  pendingBodies,
  readThread,
  saveMailbox,
  setMailboxVisibility,
  storeBody,
  TEXT_LIMIT_BYTES,
  type IncomingMessage,
} from '../src/dal/messages.ts'

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
  const [ws] = await owner`select id from account where slug = 'datasaur'`
  if (!ws) throw new Error('Seed the database first: pnpm db:seed')
  const accountId = ws.id as string

  const person = async (email: string) => {
    const [row] = await owner`select id, email, name from user_account where email = ${email}`
    if (!row) throw new Error(`no seeded user ${email}`)
    return row as { id: string; email: string; name: string }
  }
  const salesUser = await person('sales@datasaur.ai')
  const marketingUser = await person('marketing@datasaur.ai')
  const adminUser = await person('admin@datasaur.ai')

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

  const sharedForMarketing = await readThread(marketing, threadId)
  check(sharedForMarketing !== null, 'a shared mailbox is readable by a colleague')

  await setMailboxVisibility(sales, { mailboxId: box.id, visibility: 'private' })
  check((await readThread(marketing, threadId)) === null, 'a private mailbox is not')
  check((await readThread(sales, threadId)) !== null, 'its owner still reads it')
  check((await readThread(admin, threadId)) !== null, 'and so does an admin')

  const hiddenInbox = await listInboxThreads(marketing, {})
  check(
    !hiddenInbox.threads.some((thread) => thread.id === threadId),
    'a private thread is absent from a colleague’s inbox as well as from the record',
  )

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

  const searched = await listInboxThreads(sales, { q: 'Trial questions', limit: 50 })
  check(searched.threads.some((thread) => thread.id === threadId), 'search matches a subject')
  const missing = await listInboxThreads(sales, { q: `nothing-${stamp}`, limit: 50 })
  check(missing.threads.length === 0, 'and matches nothing when nothing matches')

  const firstPage = await listInboxThreads(sales, { limit: 1 })
  const secondPage = firstPage.cursor
    ? await listInboxThreads(sales, { limit: 1, cursor: firstPage.cursor })
    : { threads: [] }
  check(
    !secondPage.threads.some((thread) => firstPage.threads.some((seen) => seen.id === thread.id)),
    'the keyset page does not repeat a thread it already showed',
  )

  // Everything this script made goes with it.
  await withAccount(admin, async (tx) => {
    await tx.execute(sql`delete from message_thread where provider_thread_id like ${`mail-%${stamp}`}`)
  })
  await owner`delete from message_thread where provider_thread_id like ${`mail-%-${stamp}`}`
  await owner`delete from mailbox where id = ${box.id}`
  await owner`delete from contact where account_id = ${accountId} and email like ${`body-${stamp}%`}`
} finally {
  await Promise.all([owner.end(), closeAppPool()])
}

if (failures.length) {
  console.error(`\n${failures.length} mail check(s) failed.`)
  process.exit(1)
}
console.log('\nall mail checks passed.')
