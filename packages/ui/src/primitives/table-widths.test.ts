import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_WIDTH, MIN_WIDTH, parseWidths, widthFor, widthsKey } from './table-widths.ts'

/** A resize that is stored and then not rendered is the same to somebody using
 *  the table as a resize that was never stored at all. */

test('what one table stored is not read by another', () => {
  assert.equal(widthsKey('contact.all'), 'rawr.widths.contact.all')
  assert.notEqual(widthsKey('contact.all'), widthsKey('contact.mine'))
})

test('a stored width beats both the asked-for width and the default', () => {
  const widths = parseWidths('{"name":420}')
  assert.equal(widthFor(widths, { key: 'name', width: 180 }), 420)
  assert.equal(widthFor(widths, { key: 'email', width: 240 }), 240)
  assert.equal(widthFor(widths, { key: 'email' }), DEFAULT_WIDTH)
})

test('nothing stored resolves to what the caller asked for', () => {
  assert.deepEqual(parseWidths(null), {})
  assert.equal(widthFor(parseWidths(null), { key: 'name', width: 300 }), 300)
})

test('a width narrower than the handle is widened to it', () => {
  assert.deepEqual(parseWidths('{"name":10}'), { name: MIN_WIDTH })
})

test('an entry that is not a finite number is dropped, not rendered', () => {
  assert.deepEqual(parseWidths('{"name":null,"email":"240","phone":420}'), { phone: 420 })
  assert.equal(widthFor(parseWidths('{"name":null}'), { key: 'name', width: 180 }), 180)
})

test('anything that is not an object of widths reads as nothing stored', () => {
  assert.deepEqual(parseWidths('not json'), {})
  assert.deepEqual(parseWidths('null'), {})
  assert.deepEqual(parseWidths('[420]'), {})
  assert.deepEqual(parseWidths('""'), {})
})
