import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inSentence } from './label-case.ts'

test('lowercases an ordinary label', () => {
  assert.equal(inSentence('Contacts'), 'contacts')
  assert.equal(inSentence('Deal'), 'deal')
})

test('leaves a label alone when it carries an uppercase past the first letter', () => {
  assert.equal(inSentence('UI Drive Assets'), 'UI Drive Assets')
  assert.equal(inSentence('NPS Response'), 'NPS Response')
  assert.equal(inSentence('Acme Order'), 'Acme Order')
})

test('survives an empty label and one of a single letter', () => {
  assert.equal(inSentence(''), '')
  assert.equal(inSentence('A'), 'a')
})
