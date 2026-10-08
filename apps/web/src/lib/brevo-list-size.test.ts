import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { brevoListLine } from './brevo-list-size.ts'

const grouped = (value: number) => value.toLocaleString('en-US')

describe('brevoListLine', () => {
  it('names the list, the contact count and the blocked count with the viewer format', () => {
    assert.equal(
      brevoListLine('12', { subscribers: 1834, blacklisted: 56 }, grouped),
      'Brevo list 12 has 1,834 contacts, 56 blocked in Brevo.',
    )
  })

  it('uses the singular for one contact', () => {
    assert.equal(brevoListLine('7', { subscribers: 1, blacklisted: 0 }, String), 'Brevo list 7 has 1 contact, 0 blocked in Brevo.')
  })

  it('an empty list still reads as a count', () => {
    assert.equal(brevoListLine('7', { subscribers: 0, blacklisted: 0 }, String), 'Brevo list 7 has 0 contacts, 0 blocked in Brevo.')
  })
})
