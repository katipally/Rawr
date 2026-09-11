import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tickStride, visibleTicks } from './axis.ts'

/** The date a reader is looking for is either legible or it is not there; a date
 *  rendered as one letter and an ellipsis is neither. */

test('a month of dates thins to what the width holds', () => {
  // "1 Sep" at 12px is about 47px with its gap, so a 720px card holds fifteen.
  const stride = tickStride(30, 5, 720)
  assert.equal(stride, 2)
  const shown = visibleTicks(30, stride)
  assert.ok(shown.has(0))
  assert.ok(shown.has(29))
  assert.ok(shown.size < 30)
})

test('the same month on a phone thins harder', () => {
  const narrow = visibleTicks(30, tickStride(30, 5, 360)).size
  const wide = visibleTicks(30, tickStride(30, 5, 1200)).size
  assert.ok(narrow < wide, `${narrow} labels at 360px, ${wide} at 1200px`)
})

test('a short range draws every label', () => {
  assert.equal(tickStride(7, 5, 720), 1)
  assert.deepEqual(visibleTicks(7, 1), new Set([0, 1, 2, 3, 4, 5, 6]))
})

test('a longer label needs more room, so fewer are drawn', () => {
  assert.ok(tickStride(30, 16, 720) > tickStride(30, 5, 720))
})

test('the last column is always drawn and nothing crowds it', () => {
  const shown = visibleTicks(30, 7)
  assert.ok(shown.has(29))
  assert.ok(!shown.has(28))
  assert.deepEqual([...shown].sort((a, b) => a - b), [0, 7, 14, 21, 29])
})

test('one column and no columns are both drawable', () => {
  assert.deepEqual(visibleTicks(1, 4), new Set([0]))
  assert.deepEqual(visibleTicks(0, 4), new Set())
  assert.equal(tickStride(1, 5, 0), 1)
})

test('an unmeasured row thins as if it were a phone rather than not at all', () => {
  assert.equal(tickStride(30, 5, 0), tickStride(30, 5, 320))
})
