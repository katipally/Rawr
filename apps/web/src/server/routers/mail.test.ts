import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AccountContext } from '@rawr/db'
import { TRPCError } from '@trpc/server'
import { SEND_REFUSED } from '~/lib/mail-compose.ts'
import type { Context } from '../trpc.ts'
import { mailRouter } from './mail.ts'

const seat = (viewHubs: AccountContext['viewHubs'], editHubs: AccountContext['editHubs'], isSuperAdmin = false): AccountContext => ({
  accountId: '00000000-0000-4000-8000-000000000001',
  actorId: '00000000-0000-4000-8000-000000000002',
  actorKind: 'user',
  isSuperAdmin,
  viewHubs,
  editHubs,
})

const callerFor = (account: AccountContext) =>
  mailRouter.createCaller({
    session: { accountSlug: 'acme', accountName: 'Acme' } as unknown as Context['session'],
    account,
    requestedAccount: null,
  })

/** A compose that is well formed, so only the gate can refuse it. The mailbox
 *  does not exist, so an allowed seat fails later, inside compose, not here. */
const message = { mailboxId: '00000000-0000-4000-8000-000000000003', to: 'a@example.test', subject: 'Hi', text: 'Hello' }

const refusal = async (account: AccountContext) => {
  try {
    await callerFor(account).compose(message)
    return null
  } catch (cause) {
    return cause instanceof TRPCError ? cause : null
  }
}

test('a view-only seat is refused before anything reaches Gmail', async () => {
  const error = await refusal(seat(['contacts'], []))
  assert.equal(error?.code, 'FORBIDDEN')
  assert.equal(error?.message, SEND_REFUSED)
})

test('a sales-only seat is refused, because sending is a contacts grant', async () => {
  const error = await refusal(seat(['sales'], ['sales']))
  assert.equal(error?.code, 'FORBIDDEN')
})

test('a contacts editor and a super admin pass the gate', async () => {
  for (const account of [seat(['contacts'], ['contacts']), seat([], [], true)]) {
    const error = await refusal(account)
    assert.notEqual(error?.code, 'FORBIDDEN')
  }
})
