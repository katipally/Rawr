import assert from 'node:assert/strict'
import { test } from 'node:test'
import { folderChanges, gmailLabelsFor, labelsOfThread, threadStateFromLabels } from './thread-state.ts'

test('a thread with a message in the Inbox is not archived, whatever else it carries', () => {
  assert.deepEqual(threadStateFromLabels([['SENT'], ['INBOX', 'UNREAD']]), { archived: false, trashed: false })
})

test('a thread with no message in the Inbox is archived', () => {
  assert.deepEqual(threadStateFromLabels([['SENT'], ['CATEGORY_UPDATES']]), { archived: true, trashed: false })
})

test('Trash wins over the Inbox and over archiving', () => {
  assert.deepEqual(threadStateFromLabels([['INBOX'], ['TRASH']]), { archived: false, trashed: true })
  assert.deepEqual(threadStateFromLabels([['TRASH']]), { archived: false, trashed: true })
})

test('labelsOfThread reports each folder if any message carries it', () => {
  assert.deepEqual(labelsOfThread([[], ['INBOX']]), { trashed: false, inInbox: true })
  assert.deepEqual(labelsOfThread([[], []]), { trashed: false, inInbox: false })
})

test('what Gmail should carry: Trash, else the Inbox unless archived', () => {
  assert.deepEqual(gmailLabelsFor({ archived: false, trashed: false }), { trashed: false, inbox: true })
  assert.deepEqual(gmailLabelsFor({ archived: true, trashed: false }), { trashed: false, inbox: false })
  assert.deepEqual(gmailLabelsFor({ archived: false, trashed: true }), { trashed: true, inbox: false })
})

test('a push sends only the differences, so a thread already in order sends nothing', () => {
  const settled = { trashed: false, inInbox: true }
  assert.deepEqual(folderChanges(settled, { trashed: false, inbox: true }), {
    trash: false,
    untrash: false,
    addInbox: false,
    removeInbox: false,
  })
})

test('archiving removes the Inbox label, moving back adds it', () => {
  assert.deepEqual(folderChanges({ trashed: false, inInbox: true }, { trashed: false, inbox: false }), {
    trash: false,
    untrash: false,
    addInbox: false,
    removeInbox: true,
  })
  assert.deepEqual(folderChanges({ trashed: false, inInbox: false }, { trashed: false, inbox: true }), {
    trash: false,
    untrash: false,
    addInbox: true,
    removeInbox: false,
  })
})

test('deleting trashes, restoring untrashes and puts the thread back in the Inbox', () => {
  assert.deepEqual(folderChanges({ trashed: false, inInbox: true }, { trashed: true, inbox: false }), {
    trash: true,
    untrash: false,
    addInbox: false,
    removeInbox: true,
  })
  assert.deepEqual(folderChanges({ trashed: true, inInbox: false }, { trashed: false, inbox: true }), {
    trash: false,
    untrash: true,
    addInbox: true,
    removeInbox: false,
  })
})
