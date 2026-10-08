import assert from 'node:assert/strict'
import { test } from 'node:test'
import { choicesText, parseChoices, pasteRows } from './choices.ts'

test('one choice per line, value and label the same', () => {
  assert.deepEqual(parseChoices('Red\nGreen'), [
    { value: 'Red', label: 'Red' },
    { value: 'Green', label: 'Green' },
  ])
})

test('blank lines, padding and CRLF line ends are not part of a choice', () => {
  assert.deepEqual(parseChoices('  Red wine \r\n\n \nWhite\n').map((choice) => choice.label), ['Red wine', 'White'])
})

test('a comma is part of a choice, not a separator', () => {
  assert.deepEqual(parseChoices('Smith, John\nDoe, Jane').map((choice) => choice.label), ['Smith, John', 'Doe, Jane'])
})

test('empty text is no choices, and non-Latin choices pass through', () => {
  assert.deepEqual(parseChoices(''), [])
  assert.deepEqual(parseChoices('レッド\n\u{1F680}').map((choice) => choice.label), ['レッド', '\u{1F680}'])
})

test('text built from choices parses back to the same choices', () => {
  const choices = parseChoices('a\nb c\nd, e')
  assert.deepEqual(parseChoices(choicesText(choices)), choices)
  assert.equal(choicesText(undefined), '')
})

test('a paste with no line break is left to the input', () => {
  assert.equal(pasteRows('ab', 1, 1, 'Red'), null)
  assert.equal(pasteRows('ab', 0, 0, ''), null)
})

test('a multi-line paste becomes one row per line, and blank lines are dropped', () => {
  assert.deepEqual(pasteRows('', 0, 0, 'Red\n\n Green \r\nBlue\n'), ['Red', 'Green', 'Blue'])
})

test('a multi-line paste keeps the text before the caret on the first row and after it on the last', () => {
  assert.deepEqual(pasteRows('Pre fix', 3, 3, 'Red\nGreen'), ['PreRed', 'Green fix'])
  assert.deepEqual(pasteRows('old', 0, 3, 'A\nB\nC'), ['A', 'B', 'C'])
})

test('a paste of only blank lines is not a multi-line paste', () => {
  assert.equal(pasteRows('ab', 2, 2, '\n \n'), null)
})
