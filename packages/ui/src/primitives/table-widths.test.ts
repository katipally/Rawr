import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_WIDTH, layoutWidths, MIN_WIDTH, parseWidths, widthFor, widthsKey } from './table-widths.ts'

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

test('columns nobody has dragged fill the box exactly', () => {
  const columns = [{ key: 'name' }, { key: 'email' }, { key: 'actions', width: 100 }]
  const rendered = layoutWidths({}, columns, 1000)
  assert.equal(
    rendered.reduce((sum, width) => sum + width, 0),
    1000,
  )
  assert.ok((rendered[0] as number) > (rendered[2] as number))
})

test('two columns and forty columns both fit', () => {
  const forty = Array.from({ length: 40 }, (_, index) => ({ key: `c${index}` }))
  const wide = layoutWidths({}, forty, 1000)
  // Forty columns cannot fit 1000px without going under the minimum, so this is
  // the case that is meant to overflow, at exactly the minimum each.
  assert.deepEqual(new Set(wide), new Set([MIN_WIDTH]))
  assert.equal(
    layoutWidths({}, [{ key: 'a' }, { key: 'b' }], 900).reduce((sum, width) => sum + width, 0),
    900,
  )
})

test('a dragged column keeps its width and the rest re-share what is left', () => {
  const columns = [{ key: 'name' }, { key: 'email' }, { key: 'actions' }]
  const rendered = layoutWidths({ name: 600 }, columns, 1000)
  assert.equal(rendered[0], 600)
  assert.equal(
    rendered.reduce((sum, width) => sum + width, 0),
    1000,
  )
})

test('dragging past the box is what makes the table overflow', () => {
  const rendered = layoutWidths({ name: 900, email: 900 }, [{ key: 'name' }, { key: 'email' }], 1000)
  assert.deepEqual(rendered, [900, 900])
})

test('an unmeasured box renders the asked-for widths', () => {
  assert.deepEqual(layoutWidths({}, [{ key: 'a', width: 300 }, { key: 'b' }], 0), [300, DEFAULT_WIDTH])
})
