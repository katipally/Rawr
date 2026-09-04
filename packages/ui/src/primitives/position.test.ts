import assert from 'node:assert/strict'
import { test } from 'node:test'
import { anchor, type Box } from './position.ts'

/** The rules a layer follows near an edge. Every anchored primitive shares this
 *  arithmetic, so a bug here puts every menu, tooltip and popover off-screen. */

const viewport = { width: 1000, height: 800 }
const layer: Box = { top: 0, left: 0, width: 200, height: 100 }
const at = (top: number, left: number): Box => ({ top, left, width: 100, height: 30 })

test('sits below its anchor, centred, when there is room', () => {
  const placed = anchor(at(200, 400), layer, { viewport })
  assert.equal(placed.side, 'bottom')
  assert.equal(placed.top, 236) // 200 + 30 + 6 gap
  assert.equal(placed.left, 350) // centred: 400 + (100 - 200) / 2
})

test('flips above when the bottom would overflow', () => {
  const placed = anchor(at(750, 400), layer, { viewport })
  assert.equal(placed.side, 'top')
  assert.equal(placed.top, 644) // 750 - 100 - 6
})

test('keeps the preferred side when neither side fits, and clamps', () => {
  const tall = { ...layer, height: 700 }
  const placed = anchor(at(400, 400), tall, { viewport })
  assert.equal(placed.side, 'bottom')
  assert.equal(placed.top, 92) // clamped to viewport height - layer - padding
})

test('clamps to the left padding rather than hanging off the edge', () => {
  const placed = anchor(at(200, 10), layer, { viewport })
  assert.equal(placed.left, 8)
})

test('clamps to the right padding', () => {
  const placed = anchor(at(200, 960), layer, { viewport })
  assert.equal(placed.left, 792) // 1000 - 200 - 8
})

test('aligns to the start and the end of its anchor', () => {
  assert.equal(anchor(at(200, 400), layer, { viewport, align: 'start' }).left, 400)
  assert.equal(anchor(at(200, 400), layer, { viewport, align: 'end' }).left, 300)
})

test('a right-side layer flips left when it would overflow', () => {
  const placed = anchor(at(200, 900), layer, { viewport, side: 'right' })
  assert.equal(placed.side, 'left')
  assert.equal(placed.left, 694) // 900 - 200 - 6
})

test('a viewport smaller than the layer still returns a positive position', () => {
  const placed = anchor(at(10, 10), layer, { viewport: { width: 120, height: 60 } })
  assert.equal(placed.top, 8)
  assert.equal(placed.left, 8)
})
