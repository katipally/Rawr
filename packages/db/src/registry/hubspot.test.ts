import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACTIVITY_IMPORT, hubspotActivityPreset, hubspotPreset, looksLikeHubspot } from './hubspot.ts'
import { suggestMapping } from '../dal/imports.ts'

/** Reading a HubSpot export. Getting this wrong is not a crash: it is a column
 *  quietly landing in the wrong field across ninety thousand rows. */

const CONTACT_EXPORT = [
  'Record ID',
  'First Name',
  'Last Name',
  'Email',
  'Phone Number',
  'Job Title',
  'Associated Company',
  'Contact owner',
  'Lifecycle Stage',
  'Lead Status',
  'Create Date',
  'Last Activity Date',
]

test('a HubSpot contact export is recognised by its own columns', () => {
  assert.equal(looksLikeHubspot(CONTACT_EXPORT), true)
})

test('a file somebody typed is not mistaken for a HubSpot export', () => {
  assert.equal(looksLikeHubspot(['Name', 'Email', 'Notes']), false)
})

test('one HubSpot-shaped header is not enough on its own', () => {
  // "Create Date" alone appears in plenty of hand-made exports.
  assert.equal(looksLikeHubspot(['Name', 'Email', 'Create Date']), false)
})

test('the columns HubSpot puts in every export are dismissed, not offered', () => {
  const preset = hubspotPreset('contact', CONTACT_EXPORT)
  assert.equal(preset['Record ID'], null)
  assert.equal(preset['Last Activity Date'], null)
})

test('an association column becomes the relation it names', () => {
  const preset = hubspotPreset('contact', CONTACT_EXPORT)
  assert.equal(preset['Associated Company'], 'company_id')
  assert.equal(preset['Contact owner'], 'owner_id')
  assert.equal(preset['Job Title'], 'title')
})

test('two headers cannot claim the same field', () => {
  // HubSpot exports both, and only the first may win: mapping both would write
  // one over the other with whichever row happened to come second.
  const preset = hubspotPreset('contact', ['Phone Number', 'Mobile Phone Number'])
  assert.equal(preset['Phone Number'], 'phone')
  assert.equal('Mobile Phone Number' in preset, false)
})

test('a deal export maps the three columns a deal cannot exist without', () => {
  const preset = hubspotPreset('deal', ['Deal Name', 'Deal Stage', 'Close Date', 'Deal owner', 'Deal probability'])
  assert.equal(preset['Deal Name'], 'name')
  assert.equal(preset['Deal Stage'], 'stage_id')
  assert.equal(preset['Close Date'], 'close_date')
  // Recognised and deliberately not carried: Rawr reads probability off the stage.
  assert.equal('Deal probability' in preset, false)
})

test('a preset beats the loose label match', () => {
  // "Associated Company" would loosely match nothing useful, and "Company Name"
  // would match the company object's name rather than the contact's relation.
  const object = { key: 'contact', fields: [], byKey: new Map() } as never
  const mapping = suggestMapping(object, ['Associated Company'], hubspotPreset('contact', CONTACT_EXPORT))
  assert.equal(mapping['Associated Company'], 'company_id')
})

test('an activity export names the record and the moment', () => {
  const preset = hubspotActivityPreset(['Associated Contact', 'Activity Type', 'Activity Date', 'Note Body', 'Record ID'])
  assert.equal(preset['Associated Contact'], 'contact_email')
  assert.equal(preset['Activity Type'], 'activity_type')
  assert.equal(preset['Activity Date'], 'occurred_at')
  assert.equal(preset['Note Body'], 'body')
  assert.equal(preset['Record ID'], 'external_id')
})

test('the activity shape carries the two columns a timeline entry cannot do without', () => {
  assert.equal(ACTIVITY_IMPORT.byKey.has('contact_email'), true)
  assert.equal(ACTIVITY_IMPORT.byKey.get('occurred_at')?.type, 'datetime')
  assert.deepEqual(ACTIVITY_IMPORT.byKey.get('activity_type')?.options, ['note', 'email', 'call', 'meeting'])
})
