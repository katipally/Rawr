import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  companyNameFromDomain,
  employerDomainFromEmail,
  isFreeMailDomain,
  normaliseEmail,
  registrableDomain,
} from './domains.ts'

/** The one function that decides whether two spellings are the same company.
 *  Import, forms, Gmail matching and the record UI all call it, so a change here
 *  silently re-partitions 34,648 companies. These are the shapes that actually
 *  arrive: pasted URLs, addresses with display names, trailing dots, ports. */

test('registrableDomain takes anything a person pastes', () => {
  const same = 'acme.com'
  for (const input of [
    'acme.com',
    'ACME.com',
    '  acme.com  ',
    'www.acme.com',
    'https://acme.com',
    'https://WWW.Acme.com/pricing?utm_source=x',
    'http://user:pw@acme.com:8443/path',
    'someone@acme.com',
    'acme.com.',
  ]) {
    assert.equal(registrableDomain(input), same, input)
  }
})

test('a public suffix keeps its second level and never collapses to the suffix', () => {
  assert.equal(registrableDomain('shop.acme.co.uk'), 'acme.co.uk')
  assert.equal(registrableDomain('acme.co.uk'), 'acme.co.uk')
  // "co.uk" is not a company anyone can register.
  assert.equal(registrableDomain('co.uk'), null)
})

test('registrableDomain refuses what is not a domain', () => {
  for (const input of [null, undefined, '', '   ', 'acme', 'two words.com', '192.168.0.1', '@']) {
    assert.equal(registrableDomain(input), null, String(input))
  }
})

test('a new gTLD is an employer, not free mail', () => {
  // The bug this guards: an earlier version refused anything the bundled public
  // suffix list did not know, which threw away real employers on new gTLDs.
  assert.equal(isFreeMailDomain('datasaur.ai'), false)
  assert.equal(employerDomainFromEmail('trevor@datasaur.ai'), 'datasaur.ai')
})

test('a personal address implies no employer', () => {
  assert.equal(isFreeMailDomain('gmail.com'), true)
  assert.equal(employerDomainFromEmail('someone@gmail.com'), null)
  // Unparseable input is treated as free mail, so it can never become a company.
  assert.equal(isFreeMailDomain('nonsense'), true)
})

test('companyNameFromDomain reads as a name', () => {
  assert.equal(companyNameFromDomain('acme-labs.co.uk'), 'Acme Labs')
  assert.equal(companyNameFromDomain('datasaur.ai'), 'Datasaur')
})

test('normaliseEmail lowercases and refuses anything that is not an address', () => {
  assert.equal(normaliseEmail('  Trevor@Datasaur.AI '), 'trevor@datasaur.ai')
  for (const input of [null, '', 'trevor', 'trevor@', '@datasaur.ai', 'a b@c.com']) {
    assert.equal(normaliseEmail(input), null, String(input))
  }
})
