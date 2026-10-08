import assert from 'node:assert/strict'
import { beforeEach, describe, it, mock } from 'node:test'
import type { AccountContext } from '@rawr/db'

/** Database calls are replaced, so the test can name every write that happened.
 *  Runs in its own process (node --test starts one per file), so the stand-in flag
 *  is set before env.ts is read. */
const writes: string[] = []
let externalId: string | null = null
const contact = { values: { email: 'ada@example.com', first_name: 'Ada' } }
const unused = async () => {
  throw new Error('not used by the sequence paths')
}

mock.module('@rawr/db', {
  namedExports: {
    applyEnrichment: unused,
    checkOutboundUrl: unused,
    contactsLinkedTo: unused,
    readCredentials: unused,
    recordDeadLetter: unused,
    recordOutboundCall: unused,
    refusedAddress: unused,
    getRecord: async () => contact,
    externalIdOf: async () => externalId,
    ingestMarketingEvent: async (_ctx: AccountContext, event: { kind: string }) => {
      writes.push(`ingest:${event.kind}`)
      return { stored: true, matched: true, reason: null }
    },
    setExternalId: async (_ctx: AccountContext, _contactId: string, provider: string) => {
      writes.push(`externalId:${provider}`)
    },
    recordHealth: async (_ctx: AccountContext, provider: string) => {
      writes.push(`health:${provider}`)
    },
  },
})

const ctx: AccountContext = {
  accountId: '00000000-0000-4000-8000-000000000000',
  actorId: null,
  actorKind: 'user',
  isSuperAdmin: true,
  viewHubs: [],
  editHubs: [],
}
const contactId = '00000000-0000-4000-8000-000000000001'

process.env.RAWR_DEV_INTEGRATIONS = '1'
const { readSequenceStatus, syncSequenceActivity } = await import('./apollo.ts')

beforeEach(() => {
  writes.length = 0
  externalId = 'dev-apollo-00000000'
})

describe('readSequenceStatus', () => {
  it('reads where the sequences got to and writes nothing', async () => {
    const statuses = await readSequenceStatus(ctx, contactId)
    assert.deepEqual(statuses.map((row) => [row.sequenceName, row.status]), [['Trial follow-up', 'active']])
    assert.deepEqual(writes, [])
  })

  it('reads as none, and creates nothing, for a contact Apollo was never matched to', async () => {
    externalId = null
    assert.deepEqual(await readSequenceStatus(ctx, contactId), [])
    assert.deepEqual(writes, [])
  })
})

describe('syncSequenceActivity', () => {
  it('writes every event once, stamps the sync time and records a healthy Apollo', async () => {
    const { statuses, recorded } = await syncSequenceActivity(ctx, contactId)
    assert.equal(statuses.length, 1)
    assert.equal(recorded, 2)
    assert.deepEqual(writes, [
      'ingest:sequence_step',
      'ingest:sequence_reply',
      'externalId:apollo:synced_at',
      'health:apollo',
    ])
  })
})
