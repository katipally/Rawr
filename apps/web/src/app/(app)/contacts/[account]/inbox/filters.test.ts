import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filtersFrom, mailboxFilter, toParams, type InboxFilters } from './filters.ts'

const all: InboxFilters = { scope: 'all', mailboxId: null, unreplied: false, unread: false, q: null }

test('toParams emits only the filters that are set', () => {
  assert.deepEqual(toParams(all), { scope: undefined, mailbox: undefined, unreplied: undefined, unread: undefined, q: undefined })
  assert.deepEqual(toParams({ ...all, scope: 'mine', mailboxId: 'box', unreplied: true, unread: true, q: 'pricing' }), {
    scope: 'mine',
    mailbox: 'box',
    unreplied: '1',
    unread: '1',
    q: 'pricing',
  })
})

test('filtersFrom reads the address back into the same filters', () => {
  const filters: InboxFilters = { scope: 'mine', mailboxId: 'box', unreplied: true, unread: false, q: 'pricing' }
  assert.deepEqual(filtersFrom({ scope: 'mine', mailbox: 'box', unreplied: '1', q: 'pricing' }), filters)
  assert.deepEqual(filtersFrom({ scope: 'other', unread: '0' }), all)
})

test('filtersFrom takes the first value when a key repeats', () => {
  assert.equal(filtersFrom({ mailbox: ['a', 'b'] }).mailboxId, 'a')
})

test('picking a mailbox drops scope and keeps unread, unreplied and search', () => {
  const picked = mailboxFilter({ scope: 'mine', mailboxId: null, unreplied: true, unread: true, q: 'pricing' }, 'box')
  assert.deepEqual(picked, { scope: 'all', mailboxId: 'box', unreplied: true, unread: true, q: 'pricing' })
})

test('picking the open mailbox again clears it and keeps the other filters', () => {
  const picked = mailboxFilter({ scope: 'all', mailboxId: 'box', unreplied: false, unread: true, q: null }, 'box')
  assert.deepEqual(picked, { scope: 'all', mailboxId: null, unreplied: false, unread: true, q: null })
})

test('picking a different mailbox replaces the open one', () => {
  assert.equal(mailboxFilter({ ...all, mailboxId: 'box' }, 'other').mailboxId, 'other')
})
