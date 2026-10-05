import assert from 'node:assert/strict'
import { test } from 'node:test'
import { answersFromFormData } from './submit.ts'

/** The hosted page's no-JS path shipped broken: React posts its own $ACTION_ID
 *  field for the plain-HTML submission, the schema allowlist refused it, and every
 *  visitor without JavaScript got '"$ACTION_ID_..." is not a field on this form.'
 *  These are the shapes that actually arrive on that path. */

const form = (pairs: [string, string][]): FormData => {
  const data = new FormData()
  for (const [key, value] of pairs) data.append(key, value)
  return data
}

test('the answers survive', () => {
  assert.deepEqual(
    answersFromFormData(form([
      ['first_name', 'Trevor'],
      ['email', 'trevor@example.com'],
      ['message', 'We would like a demo.'],
    ])),
    { first_name: 'Trevor', email: 'trevor@example.com', message: 'We would like a demo.' },
  )
})

test("React's transport fields do not", () => {
  const answers = answersFromFormData(form([
    ['$ACTION_ID_400039d4699b4d681683b8c7f04d0f1fddedb8bdf3', 'whatever'],
    ['$ACTION_REF_1', 'whatever'],
    ['$ACTION_KEY', 'whatever'],
    ['email', 'trevor@example.com'],
  ]))
  assert.deepEqual(answers, { email: 'trevor@example.com' })
  assert.ok(Object.keys(answers).every((key) => !key.startsWith('$')))
})

test('nor do the two fields the page uses to say which form this is', () => {
  assert.deepEqual(
    answersFromFormData(form([
      ['rawr_form_id', 'abc'],
      ['rawr_path', 'acme/contact-us'],
      ['email', 'trevor@example.com'],
    ])),
    { email: 'trevor@example.com' },
  )
})

test('the honeypot and the attribution fields do survive, because scoring reads them', () => {
  // Only the two routing fields are dropped by name. rawr_hp_company_url is the
  // honeypot and the spam scorer needs to see whether it was filled.
  const answers = answersFromFormData(form([
    ['rawr_hp_company_url', 'http://spam.example'],
    ['rawr_referrer', 'https://google.com'],
    ['email', 'a@b.com'],
  ]))
  assert.equal(answers.rawr_hp_company_url, 'http://spam.example')
  assert.equal(answers.rawr_referrer, 'https://google.com')
})

test('a repeated key becomes an array, which is how a multi_select arrives', () => {
  const answers = answersFromFormData(form([
    ['interest', 'Pricing'],
    ['interest', 'A demo'],
    ['email', 'a@b.com'],
  ]))
  assert.deepEqual(answers.interest, ['Pricing', 'A demo'])
  // One value is still a string, not an array of one.
  assert.equal(answers.email, 'a@b.com')
})

test('a field left blank arrives as an empty string, not as missing', () => {
  // The validator distinguishes "answered with nothing" from "not asked", and a
  // required field left blank has to reach it to be refused.
  assert.deepEqual(answersFromFormData(form([['company', '']])), { company: '' })
})
