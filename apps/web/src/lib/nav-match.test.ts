import assert from 'node:assert/strict'
import { test } from 'node:test'
import { currentNavItem } from './nav-match.ts'

const items = [
  { href: '/contacts/a/reports', label: 'Reports', match: '/contacts/a/reports' },
  { href: '/contacts/a/reports?tab=dashboards', label: 'Dashboards', match: '/contacts/a/reports/dashboards' },
  { href: '/contacts/a/reports?tab=forms', label: 'Marketing Analytics', match: '/contacts/a/reports/forms' },
  { href: '/contacts/a/tasks', label: 'Tasks' },
  { href: '/', label: 'Home' },
]

test('the longest matching prefix is the current item', () => {
  assert.equal(currentNavItem(items, '/contacts/a/reports/dashboards/d1')?.label, 'Dashboards')
  assert.equal(currentNavItem(items, '/contacts/a/reports/forms')?.label, 'Marketing Analytics')
})

test('a broader item stays current where no narrower one matches', () => {
  assert.equal(currentNavItem(items, '/contacts/a/reports/events')?.label, 'Reports')
})

test('an item without match is matched by its href', () => {
  assert.equal(currentNavItem(items, '/contacts/a/tasks/new')?.label, 'Tasks')
})

test('the root item is current only on the root', () => {
  assert.equal(currentNavItem(items, '/')?.label, 'Home')
  assert.equal(currentNavItem([items[4]!], '/contacts/a'), undefined)
})

test('no match gives no current item', () => {
  assert.equal(currentNavItem(items, '/settings'), undefined)
  assert.equal(currentNavItem([], '/'), undefined)
})
