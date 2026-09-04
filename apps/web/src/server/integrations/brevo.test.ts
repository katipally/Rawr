import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseBrevoEvent } from './brevo.ts'

/** The two vocabularies Brevo actually sends, checked against its docs on
 *  2026-09-03: campaign webhooks and transactional webhooks name the same
 *  things differently, and a newsletter is a campaign. */
describe('parseBrevoEvent', () => {
  it('reads a campaign unsubscribe the way Brevo sends it', () => {
    const parsed = parseBrevoEvent({
      event: 'unsubscribe',
      email: 'Someone@Example.com',
      camp_id: 42,
      'campaign name': 'May Newsletter',
      ts_event: 1_788_000_000,
      list_id: 7,
    })
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.event.kind, 'unsubscribe')
    assert.equal(parsed.event.subject, 'May Newsletter')
    assert.equal(parsed.event.at.getTime(), 1_788_000_000_000)
    assert.equal(parsed.event.providerEventId, '42:someone@example.com:unsubscribe')
  })

  it('a click carries its URL under Brevo’s capitalised key', () => {
    const parsed = parseBrevoEvent({ event: 'click', email: 'a@b.c', camp_id: 1, URL: 'https://datasaur.ai/pricing' })
    assert.equal(parsed.ok, true)
    if (!parsed.ok) return
    assert.equal(parsed.event.kind, 'click')
    assert.equal(parsed.event.detail.link, 'https://datasaur.ai/pricing')
  })

  it('the transactional spellings are read too', () => {
    for (const [name, kind] of [['unsubscribed', 'unsubscribe'], ['unique_opened', 'open'], ['hard_bounce', 'bounce'], ['proxy_open', 'open']]) {
      const parsed = parseBrevoEvent({ event: name, email: 'a@b.c', 'message-id': '<m1>' })
      assert.equal(parsed.ok, true, name)
      if (parsed.ok) assert.equal(parsed.event.kind, kind, name)
    }
  })

  it('two recipients of one campaign are two events, and one recipient twice is one', () => {
    const one = parseBrevoEvent({ event: 'delivered', email: 'a@b.c', camp_id: 9 })
    const two = parseBrevoEvent({ event: 'delivered', email: 'd@e.f', camp_id: 9 })
    const again = parseBrevoEvent({ event: 'delivered', email: 'A@B.C', camp_id: 9 })
    assert.ok(one.ok && two.ok && again.ok)
    if (!(one.ok && two.ok && again.ok)) return
    assert.notEqual(one.event.providerEventId, two.event.providerEventId)
    assert.equal(one.event.providerEventId, again.event.providerEventId)
  })

  it('an event Rawr does not record, or one without an address, says why', () => {
    assert.deepEqual(parseBrevoEvent({ event: 'contact_updated', email: 'a@b.c' }), {
      ok: false,
      detail: 'Brevo event "contact_updated" is not one Rawr records.',
    })
    assert.equal(parseBrevoEvent({ event: 'click' }).ok, false)
  })
})
