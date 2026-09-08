import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { forwardToGa4, stripPersonal } from './ga4.ts'

/** The two rules that are the whole GA4 module: nothing without analytics
 *  consent, and nothing that could name a person.
 *
 *  Worth a test of its own because forwarding is now reached from the collector
 *  rather than by hand, so the consent check runs on a path a visitor triggers
 *  and nobody reads the result of. If it stopped refusing, nothing on screen
 *  would say so — the events would simply start arriving at Google. */

describe('stripPersonal', () => {
  it('refuses every key that could name a person, and keeps the rest', () => {
    const { clean, refused } = stripPersonal({
      email: 'someone@example.com',
      contact_id: 'abc',
      visitor_id: 'def',
      plan: 'pro',
      seats: 12,
    })
    assert.deepEqual(clean, { plan: 'pro', seats: 12 })
    assert.deepEqual(refused.sort(), ['contact_id', 'email', 'visitor_id'])
  })

  it('matches the forbidden key whatever its case', () => {
    const { clean, refused } = stripPersonal({ Email: 'a@b.c', PHONE: '123', ok: 1 })
    assert.deepEqual(clean, { ok: 1 })
    assert.deepEqual(refused.sort(), ['Email', 'PHONE'])
  })
})

describe('forwardToGa4', () => {
  it('sends nothing when analytics consent was not granted', async () => {
    // The context is never reached: refusing happens before any credential is
    // read, which is what makes this safe to call from the collector for a
    // visitor whose choice is unknown.
    const outcome = await forwardToGa4(null as never, {
      clientId: 'per-event-id',
      name: 'form_view',
      properties: { form_id: 'f1' },
      analyticsConsent: false,
    })
    assert.equal(outcome.sent, false)
    assert.match(outcome.reason ?? '', /consent/i)
  })
})
