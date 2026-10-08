import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyTaskHint, queueDeleteCopy } from './task-copy.ts'

test('the All tab points a writer at the button, and no other tab does', () => {
  assert.equal(emptyTaskHint({ filtered: false, view: 'all', canWrite: true }), 'Add one with the button above.')
  for (const view of ['today', 'overdue', 'upcoming', 'done'] as const) {
    assert.equal(emptyTaskHint({ filtered: false, view, canWrite: true }), undefined)
  }
  assert.equal(emptyTaskHint({ filtered: false, view: 'all', canWrite: false }), undefined)
})

test('a filter wins over the view hint', () => {
  assert.match(emptyTaskHint({ filtered: true, view: 'all', canWrite: true }) ?? '', /^Widen the search/)
  assert.match(emptyTaskHint({ filtered: true, view: 'done', canWrite: false }) ?? '', /^Widen the search/)
})

const count = (n: number) => String(n)

test('the queue delete copy names completed tasks and reads right at 0, 1 and many', () => {
  assert.equal(queueDeleteCopy(0, count), 'This queue has no open tasks. Nothing is deleted but the list itself.')
  assert.equal(
    queueDeleteCopy(1, count),
    '1 open task in it goes back to no queue, and so does any completed one. Nothing is deleted but the list itself.',
  )
  assert.equal(
    queueDeleteCopy(2, count),
    '2 open tasks in it go back to no queue, and so do any completed ones. Nothing is deleted but the list itself.',
  )
})

test('the queue delete count uses the caller formatting', () => {
  assert.match(queueDeleteCopy(1200, (n) => n.toLocaleString('en-US')), /^1,200 open tasks/)
})
