import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAutoReplyHeaders, isAutoReplyMail, isMachineSender, isMachineSubject } from './machine-mail.ts'

test('mail from a machine sender is not a person', () => {
  for (const from of ['mailer-daemon@googlemail.com', 'Postmaster@example.com', 'no-reply@x.io', 'noreply@x.io', 'donotreply@x.io', 'bounces@x.io']) {
    assert.equal(isMachineSender(from), true, from)
  }
  for (const from of ['ana@partner.example', 'noreplyclub@partner.example', 'sales@datasaur.ai']) {
    assert.equal(isMachineSender(from), false, from)
  }
})

test('a bounce or auto-reply subject is recognised whatever its case', () => {
  for (const subject of ['Undeliverable: Hello', 'DELIVERY STATUS NOTIFICATION (FAILURE)', 'Mail delivery failed: returning message', 'Out of Office until Monday', 'Automatic reply: Hello', 'Auto: Hello', 'Autoreply']) {
    assert.equal(isMachineSubject(subject), true, subject)
  }
  assert.equal(isMachineSubject('Hello'), false)
  assert.equal(isMachineSubject(null), false)
  assert.equal(isMachineSubject(undefined), false)
})

test('an autoresponder header makes a message an auto-reply, whatever its subject', () => {
  for (const headers of [
    { 'auto-submitted': 'auto-replied' },
    { 'auto-submitted': 'auto-generated' },
    { 'x-autoreply': 'yes' },
    { 'x-autorespond': 'yes' },
    { 'x-auto-response-suppress': 'All' },
    { precedence: 'auto_reply' },
    { precedence: 'bulk' },
    { precedence: 'junk' },
  ]) {
    assert.equal(isAutoReplyHeaders(headers), true, JSON.stringify(headers))
  }
  for (const headers of [{}, { 'auto-submitted': 'no' }, { 'auto-submitted': 'No' }, { precedence: 'list' }, { 'x-mailer': 'Outlook' }]) {
    assert.equal(isAutoReplyHeaders(headers), false, JSON.stringify(headers))
  }
})

test('an out-of-office from a person is an auto-reply by header or by subject', () => {
  assert.equal(isAutoReplyMail('Re: Hello', { 'auto-submitted': 'auto-replied' }), true)
  assert.equal(isAutoReplyMail('Out of Office', undefined), true)
  assert.equal(isAutoReplyMail('Out of Office', {}), true)
  assert.equal(isAutoReplyMail('Re: Hello', {}), false)
  assert.equal(isAutoReplyMail('Re: Hello', { 'auto-submitted': 'no' }), false)
  assert.equal(isAutoReplyMail(null, undefined), false)
})
