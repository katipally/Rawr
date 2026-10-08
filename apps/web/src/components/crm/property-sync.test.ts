import assert from 'node:assert/strict'
import { test } from 'node:test'
import { type PanelSync, editKeyAction, readArrived, reloadRequested } from './property-sync.ts'

const conflicted: PanelSync = {
  base: 'old',
  reloading: null,
  errors: { title: { message: 'Someone else changed it. Reload to see it, then apply your change again.', conflict: true } },
}

test('Reload asks for a read and keeps the conflict until that read answers it', () => {
  const asked = reloadRequested(conflicted, 'title')
  assert.equal(asked.reloading, 'title')
  assert.deepEqual(asked.errors, conflicted.errors)
  assert.equal(asked.base, 'old')
})

test('the read a Reload asked for moves the base, clears the conflict and leaves a neutral note', () => {
  const settled = readArrived(reloadRequested(conflicted, 'title'), { title: 'new' }, {})
  assert.equal(settled.base, 'new')
  assert.equal(settled.reloading, null)
  assert.deepEqual(settled.errors.title, {
    message: 'Reloaded. Your text is kept. Save to apply it over "new".',
    conflict: false,
  })
})

test('a relation shows its label in the note, never the stored id', () => {
  const pending = reloadRequested({ base: 'id-1', reloading: null, errors: {} }, 'owner_id')
  const settled = readArrived(pending, { owner_id: 'id-2' }, { owner_id: 'Ada Lovelace' })
  assert.equal(settled.errors.owner_id?.message, 'Reloaded. Your text is kept. Save to apply it over "Ada Lovelace".')
  assert.equal(settled.base, 'id-2')
})

test('a relation whose target is gone reads as the record value, not an id', () => {
  const pending = reloadRequested({ base: 'id-1', reloading: null, errors: {} }, 'owner_id')
  const settled = readArrived(pending, { owner_id: null }, { owner_id: '' })
  assert.equal(settled.errors.owner_id?.message, "Reloaded. Your text is kept. Save to apply it over the record's current value.")
})

test('a background read leaves the base and the conflict where the editor found them', () => {
  const refreshed = readArrived(conflicted, { title: 'changed by someone else' }, {})
  assert.equal(refreshed, conflicted)
  assert.equal(refreshed.base, 'old')
})

test('a second Reload after the note settles again against the value then stored', () => {
  const first = readArrived(reloadRequested(conflicted, 'title'), { title: 'v2' }, {})
  const second = readArrived(reloadRequested(first, 'title'), { title: 'v3' }, {})
  assert.equal(second.base, 'v3')
  assert.equal(second.errors.title?.message, 'Reloaded. Your text is kept. Save to apply it over "v3".')
})

test('Enter saves and Escape cancels an inline edit', () => {
  const plain = { keepsEnter: false, composing: false }
  assert.equal(editKeyAction('Enter', plain), 'save')
  assert.equal(editKeyAction('Escape', plain), 'cancel')
  assert.equal(editKeyAction('Escape', { keepsEnter: true, composing: false }), 'cancel')
  assert.equal(editKeyAction('a', plain), null)
})

test('Enter keeps its newline in a text area, a rich note and a focused button', () => {
  assert.equal(editKeyAction('Enter', { keepsEnter: true, composing: false }), null)
})

test('Enter that confirms an IME composition does not save', () => {
  assert.equal(editKeyAction('Enter', { keepsEnter: false, composing: true }), null)
})
