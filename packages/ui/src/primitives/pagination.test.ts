import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageRange } from './pagination.ts'

/** What the pager may claim. The lists behind it are keyset paged, so "how many
 *  in total" is often unknown, and saying so is the point. */

test('counts from one and names the total', () => {
  const range = pageRange({ count: 50, offset: 0, total: 1204 })
  assert.equal(range.label, 'Showing 1-50 of 1,204')
  assert.equal(range.canPrevious, false)
  assert.equal(range.canNext, true)
})

test('a later page can go back', () => {
  const range = pageRange({ count: 50, offset: 50, total: 1204 })
  assert.equal(range.label, 'Showing 51-100 of 1,204')
  assert.equal(range.canPrevious, true)
})

test('the last page cannot go forward', () => {
  const range = pageRange({ count: 4, offset: 1200, total: 1204 })
  assert.equal(range.to, 1204)
  assert.equal(range.canNext, false)
})

test('no rows says so and offers nothing', () => {
  const range = pageRange({ count: 0, offset: 0, total: 0, noun: 'contacts' })
  assert.equal(range.label, 'No contacts')
  assert.equal(range.from, 0)
  assert.equal(range.canNext, false)
})

test('an empty page after the first can still go back', () => {
  assert.equal(pageRange({ count: 0, offset: 50 }).canPrevious, true)
})

test('an unknown total omits it rather than guessing', () => {
  assert.equal(pageRange({ count: 25, offset: 0 }).label, 'Showing 1-25')
})

test('an explicit hasMore beats the total arithmetic', () => {
  assert.equal(pageRange({ count: 25, offset: 0, total: 1000, hasMore: false }).canNext, false)
  assert.equal(pageRange({ count: 25, offset: 0, hasMore: true }).canNext, true)
})

test('a single row reads as a range of one', () => {
  assert.equal(pageRange({ count: 1, offset: 0, total: 1 }).label, 'Showing 1-1 of 1')
})
