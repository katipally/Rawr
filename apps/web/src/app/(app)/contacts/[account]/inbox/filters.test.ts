import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filtersFrom, mailboxFilter, toParams, type InboxFilters } from './filters.ts'

const all: InboxFilters = { scope: 'all', mailboxId: null, unreplied: false, unread: false, assignedToMe: false, folder: 'inbox', q: null }

test('toParams emits only the filters that are set', () => {
  assert.deepEqual(toParams(all), {
    scope: undefined,
    mailbox: undefined,
    unreplied: undefined,
    unread: undefined,
    assigned: undefined,
    folder: undefined,
    q: undefined,
  })
  assert.deepEqual(
    toParams({ ...all, scope: 'mine', mailboxId: 'box', unreplied: true, unread: true, assignedToMe: true, folder: 'trash', q: 'pricing' }),
    { scope: 'mine', mailbox: 'box', unreplied: '1', unread: '1', assigned: '1', folder: 'trash', q: 'pricing' },
  )
})

test('the Inbox folder has no address of its own, Archive and Trash do', () => {
  assert.equal(toParams({ ...all, folder: 'archived' }).folder, 'archived')
  assert.equal(toParams({ ...all, folder: 'inbox' }).folder, undefined)
})

test('filtersFrom reads the address back into the same filters', () => {
  const filters: InboxFilters = { scope: 'mine', mailboxId: 'box', unreplied: true, unread: false, assignedToMe: true, folder: 'archived', q: 'pricing' }
  assert.deepEqual(filtersFrom({ scope: 'mine', mailbox: 'box', unreplied: '1', assigned: '1', folder: 'archived', q: 'pricing' }), filters)
  assert.deepEqual(filtersFrom({ scope: 'other', unread: '0' }), all)
})

test('an unknown folder is the Inbox, and a repeated folder takes its first value', () => {
  assert.equal(filtersFrom({ folder: 'spam' }).folder, 'inbox')
  assert.equal(filtersFrom({ folder: ['trash', 'archived'] }).folder, 'trash')
})

test('filtersFrom takes the first value when a key repeats', () => {
  assert.equal(filtersFrom({ mailbox: ['a', 'b'] }).mailboxId, 'a')
})

test('picking a mailbox drops scope and keeps unread, unreplied, assignment, folder and search', () => {
  const picked = mailboxFilter({ ...all, scope: 'mine', unreplied: true, unread: true, assignedToMe: true, folder: 'archived', q: 'pricing' }, 'box')
  assert.deepEqual(picked, { ...all, scope: 'all', mailboxId: 'box', unreplied: true, unread: true, assignedToMe: true, folder: 'archived', q: 'pricing' })
})

test('picking the open mailbox again clears it and keeps the other filters', () => {
  const picked = mailboxFilter({ ...all, mailboxId: 'box', unread: true }, 'box')
  assert.deepEqual(picked, { ...all, mailboxId: null, unread: true })
})

test('picking a different mailbox replaces the open one', () => {
  assert.equal(mailboxFilter({ ...all, mailboxId: 'box' }, 'other').mailboxId, 'other')
})
