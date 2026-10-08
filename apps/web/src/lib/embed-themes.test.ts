import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readTheme } from '@rawr/db/forms'
import { themeCss } from './embed-themes.ts'

test('a form on the default look copies the neutral values into its own selector', () => {
  const css = themeCss(readTheme(undefined), '[data-rawr-form="f1"]')
  assert.match(css, /^\[data-rawr-form="f1"\] \{\n/)
  assert.match(css, /--rawr-embed-text: #33475b;/)
  assert.match(css, /--rawr-embed-cta: #ff7a59;/)
  assert.doesNotMatch(css, /!important/)
})

test('a form on another preset copies that preset, not the neutral values', () => {
  const css = themeCss(readTheme({ preset: 'dark' }), '[data-rawr-form="f1"]')
  assert.match(css, /--rawr-embed-text: #dfe3eb;/)
  assert.doesNotMatch(css, /--rawr-embed-text: #33475b;/)
})

test('a token changed on top of the preset wins over it', () => {
  const css = themeCss(readTheme({ preset: 'dark', tokens: { cta: '#00ff00' } }), '[data-rawr-form="f1"]')
  assert.match(css, /--rawr-embed-cta: #00ff00;/)
})
