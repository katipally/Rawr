import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AccountContext } from '@rawr/db'

/** Runs in its own process (node --test starts one per file), so the stand-in flag
 *  is set before env.ts is read. */
describe('pushSegmentToBrevo in the development stand-in', () => {
  it('refuses, and never reports a push that did not happen', async () => {
    process.env.RAWR_DEV_INTEGRATIONS = '1'
    const { pushSegmentToBrevo } = await import('./brevo.ts')
    const ctx: AccountContext = {
      accountId: '00000000-0000-4000-8000-000000000000',
      actorId: null,
      actorKind: 'user',
      isSuperAdmin: true,
      viewHubs: [],
      editHubs: [],
    }
    await assert.rejects(
      pushSegmentToBrevo(ctx, { segmentId: '00000000-0000-4000-8000-000000000001' }),
      { message: 'Brevo is the development stand-in, so nothing was pushed.' },
    )
  })
})

describe('sendBrevoCampaign in the development stand-in', () => {
  it('refuses, and never reports a campaign that did not go out', async () => {
    process.env.RAWR_DEV_INTEGRATIONS = '1'
    const { sendBrevoCampaign } = await import('./brevo.ts')
    const ctx: AccountContext = {
      accountId: '00000000-0000-4000-8000-000000000000',
      actorId: null,
      actorKind: 'user',
      isSuperAdmin: true,
      viewHubs: [],
      editHubs: [],
    }
    await assert.rejects(sendBrevoCampaign(ctx, 42), { message: 'Brevo is the development stand-in, so nothing was sent.' })
  })
})
