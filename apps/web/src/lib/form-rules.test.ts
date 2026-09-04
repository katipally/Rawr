import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateAnswers, type FormField } from '@rawr/db'
import { clientFieldError, clientFieldErrorSource, type ClientField } from './form-rules.ts'

/** The browser check and the server check, held together.
 *
 *  The danger with validating in two places is not that the browser is wrong, it
 *  is that the browser becomes wrong later: somebody tightens a rule on the server
 *  and the embed keeps waving the same answers through, or somebody tightens the
 *  embed and a form that works without JavaScript stops working with it. So every
 *  case below is asserted against both, and the invariant is stated once: the
 *  browser must never refuse what the server accepts. */

const field = (over: Partial<FormField> & { key: string; label: string; type: FormField['type'] }): FormField =>
  ({ position: 0, required: false, ...over }) as FormField

/** What the server makes of one answer to one field. */
const serverError = (definition: FormField, value: unknown): string | null => {
  const { errors } = validateAnswers([definition], { [definition.key]: value })
  return errors.find((error) => error.key === definition.key)?.message ?? null
}

const bothAgree = (definition: FormField, value: unknown): void => {
  const server = serverError(definition, value)
  const client = clientFieldError(definition as unknown as ClientField, value)
  assert.equal(
    client,
    server,
    `${definition.type} "${String(value)}": browser said ${JSON.stringify(client)}, server said ${JSON.stringify(server)}`,
  )
}

test('a required field, empty and filled', () => {
  const required = field({ key: 'name', label: 'Name', type: 'text', required: true })
  bothAgree(required, '')
  bothAgree(required, '   ')
  bothAgree(required, 'Trevor')
})

test('an optional field left empty is not an error on either side', () => {
  bothAgree(field({ key: 'note', label: 'Note', type: 'text' }), '')
})

test('email', () => {
  const email = field({ key: 'email', label: 'Email', type: 'email' })
  bothAgree(email, 'trevor@datasaur.ai')
  bothAgree(email, 'not-an-address')
  bothAgree(email, 'two@@at.example')
  bothAgree(email, 'no-dot@example')
})

test('number, including its bounds', () => {
  const seats = field({ key: 'seats', label: 'Seats', type: 'number', validation: { min: 2, max: 10 } })
  bothAgree(seats, '5')
  bothAgree(seats, '1')
  bothAgree(seats, '11')
  bothAgree(seats, 'many')
})

test('phone', () => {
  const phone = field({ key: 'phone', label: 'Phone', type: 'phone' })
  bothAgree(phone, '+62 21 5555 1019')
  bothAgree(phone, 'call me')
  bothAgree(phone, '12')
})

test('url, with and without a scheme', () => {
  const site = field({ key: 'site', label: 'Website', type: 'url' })
  bothAgree(site, 'https://datasaur.ai')
  bothAgree(site, 'datasaur.ai')
  bothAgree(site, 'not a url at all')
})

test('date', () => {
  const when = field({ key: 'when', label: 'When', type: 'date' })
  bothAgree(when, '2026-09-04')
  bothAgree(when, 'soon')
})

test('length rules', () => {
  const bio = field({ key: 'bio', label: 'Bio', type: 'long_text', validation: { minLength: 5, maxLength: 10 } })
  bothAgree(bio, 'hello')
  bothAgree(bio, 'hi')
  bothAgree(bio, 'far too long to fit')
})

test('a regex rule, and one that does not compile', () => {
  const code = field({ key: 'code', label: 'Code', type: 'text', validation: { regex: '^[A-Z]{3}$' } })
  bothAgree(code, 'ABC')
  bothAgree(code, 'abc')
  // A pattern nobody can compile must not lock anybody out, on either side.
  const broken = field({ key: 'code', label: 'Code', type: 'text', validation: { regex: '([' } })
  bothAgree(broken, 'anything')
})

test('a choice that is not on offer', () => {
  const size = field({
    key: 'size',
    label: 'Size',
    type: 'select',
    options: [
      { value: 'small', label: 'Small' },
      { value: 'large', label: 'Large' },
    ],
  })
  bothAgree(size, 'small')
  bothAgree(size, 'enormous')
})

test('several choices, one of them not on offer', () => {
  const uses = field({
    key: 'uses',
    label: 'Uses',
    type: 'multi_select',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ],
  })
  bothAgree(uses, ['a', 'b'])
  bothAgree(uses, ['a', 'z'])
})

test('an answer past the length cap', () => {
  bothAgree(field({ key: 'bio', label: 'Bio', type: 'long_text' }), 'x'.repeat(5001))
})

test('the browser never refuses what the server accepts', () => {
  // The invariant, over every case above plus the awkward ones: a browser that is
  // stricter than the server locks somebody out of a form that would have worked.
  const cases: [FormField, unknown][] = [
    [field({ key: 'a', label: 'A', type: 'text' }), 'anything at all'],
    [field({ key: 'a', label: 'A', type: 'email' }), 'TREVOR@Datasaur.AI'],
    [field({ key: 'a', label: 'A', type: 'phone' }), '(021) 555-1019'],
    [field({ key: 'a', label: 'A', type: 'url' }), 'http://localhost:3000/x?y=1'],
    [field({ key: 'a', label: 'A', type: 'number' }), '-3.5'],
    [field({ key: 'a', label: 'A', type: 'date' }), '2026-02-29'],
    [field({ key: 'a', label: 'A', type: 'boolean' }), 'true'],
    [field({ key: 'a', label: 'A', type: 'text', required: true }), ' x '],
  ]
  for (const [definition, value] of cases) {
    if (serverError(definition, value) === null) {
      assert.equal(
        clientFieldError(definition as unknown as ClientField, value),
        null,
        `the browser refused ${definition.type} ${JSON.stringify(value)} that the server accepts`,
      )
    }
  }
})

test('the source shipped to the browser is the function that was tested', () => {
  const source = clientFieldErrorSource()
  assert.equal(source.startsWith('function clientFieldError'), true)
  // Nothing from outside itself, or it throws the moment it runs in the embed.
  assert.equal(/\bimport\b|\brequire\(/.test(source), false)
})
