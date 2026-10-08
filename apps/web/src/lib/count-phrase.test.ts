import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countPhrase, enrichmentLine } from './count-phrase.ts'

test('a count takes the singular only at one', () => {
  assert.equal(countPhrase(1, 'app', 'apps'), '1 app')
  assert.equal(countPhrase(2, 'app', 'apps'), '2 apps')
  assert.equal(countPhrase(0, 'app', 'apps'), '0 apps')
})

test('zero can be replaced by a plain statement', () => {
  assert.equal(countPhrase(0, 'app', 'apps', 'Nothing left to connect'), 'Nothing left to connect')
  assert.equal(countPhrase(1, 'app', 'apps', 'Nothing left to connect'), '1 app')
})

test('enrichment says the counts once, in singular and plural', () => {
  assert.equal(enrichmentLine('Lusha matched x: 1 filled.', 1, 1, []), 'Filled 1 blank field. 1 suggestion held for review below.')
  assert.equal(enrichmentLine('', 6, 2, []), 'Filled 6 blank fields. 2 suggestions held for review below.')
  assert.equal(enrichmentLine('', 3, 0, []), 'Filled 3 blank fields.')
  assert.equal(enrichmentLine('', 0, 1, []), '1 suggestion held for review below.')
})

test('a failed provider is named even when another provider filled fields', () => {
  assert.equal(enrichmentLine('', 1, 0, ['Apollo']), 'Filled 1 blank field. Apollo could not be reached.')
  assert.equal(
    enrichmentLine('', 3, 2, ['Apollo', 'Lusha']),
    'Filled 3 blank fields. 2 suggestions held for review below. Apollo could not be reached. Lusha could not be reached.',
  )
  assert.equal(enrichmentLine('', 0, 1, ['Clay']), '1 suggestion held for review below. Clay could not be reached.')
})

test('with nothing filled or held, the provider sentences are the whole answer', () => {
  assert.equal(enrichmentLine('Apollo could not be reached.', 0, 0, ['Apollo']), 'Apollo could not be reached.')
  assert.equal(
    enrichmentLine('Apollo could not be reached. Lusha has no match for a@b.c.', 0, 0, ['Apollo']),
    'Apollo could not be reached. Lusha has no match for a@b.c.',
  )
  assert.equal(enrichmentLine('No enricher is connected.', 0, 0, []), 'No enricher is connected.')
})
