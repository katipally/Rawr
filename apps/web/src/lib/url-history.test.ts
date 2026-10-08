import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hrefWith, pushParams, replaceParams } from './url-history.ts'

type Call = { method: 'pushState' | 'replaceState'; url: string }

const stubWindow = (search: string): Call[] => {
  const calls: Call[] = []
  const record = (method: Call['method']) => (_state: unknown, _title: string, url: string) => calls.push({ method, url })
  Object.assign(globalThis, {
    window: {
      location: { search, pathname: '/settings/properties' },
      history: { pushState: record('pushState'), replaceState: record('replaceState') },
    },
  })
  return calls
}

test('a tab or filter change is a history entry, so Back undoes it', () => {
  const calls = stubWindow('?tab=groups')
  pushParams({ tab: null, group: 'Deals' })
  assert.deepEqual(calls, [{ method: 'pushState', url: '/settings/properties?group=Deals' }])
})

test('a panel opening in the address does not add a history entry', () => {
  const calls = stubWindow('?tab=groups&edit=f1')
  replaceParams({ edit: null, section: 'usage' })
  assert.deepEqual(calls, [{ method: 'replaceState', url: '/settings/properties?tab=groups&section=usage' }])
})

test('hrefWith removes the closed param and keeps the rest in order', () => {
  assert.equal(hrefWith('/contacts/a/tasks', '?view=mine&edit=t1&q=x', { edit: null }), '/contacts/a/tasks?view=mine&q=x')
})

test('hrefWith leaves a bare path when nothing else is in the query', () => {
  assert.equal(hrefWith('/contacts/a/tasks', '?edit=t1', { edit: null }), '/contacts/a/tasks')
})
