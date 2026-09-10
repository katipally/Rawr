import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchesConditional, validateAnswers, type FormField } from '@rawr/db'
import {
  clientFieldError,
  clientFieldErrorSource,
  clientRuleMatches,
  type ClientField,
} from './form-rules.ts'

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

/** The property rules, held to the same invariant from the other direction: the
 *  browser must not hide a field the server would still have asked for. */
const bothRules = (
  rule: { conjunction: 'and' | 'or'; conditions: { field: string; operator: string; value?: unknown }[] },
  values: Record<string, unknown>,
): void => {
  const server = matchesConditional(rule, values)
  const client = clientRuleMatches(rule, values)
  assert.equal(
    client,
    server,
    `${JSON.stringify(rule)} over ${JSON.stringify(values)}: browser said ${client}, server said ${server}`,
  )
}

test('a rule over one text property', () => {
  const rule = { conjunction: 'and' as const, conditions: [{ field: 'industry', operator: 'is', value: 'SaaS' }] }
  bothRules(rule, { industry: 'SaaS' })
  bothRules(rule, { industry: 'saas' })
  bothRules(rule, { industry: 'Retail' })
  bothRules(rule, {})
  bothRules(rule, { industry: '' })
})

test('the operators that take no value, and the ones that take a list', () => {
  bothRules({ conjunction: 'and', conditions: [{ field: 'phone', operator: 'is_empty' }] }, { phone: '' })
  bothRules({ conjunction: 'and', conditions: [{ field: 'phone', operator: 'is_not_empty' }] }, { phone: '+44 20 7946 0000' })
  bothRules(
    { conjunction: 'and', conditions: [{ field: 'country', operator: 'in', value: ['GB', 'IE'] }] },
    { country: 'ie' },
  )
  bothRules(
    { conjunction: 'and', conditions: [{ field: 'country', operator: 'not_in', value: ['GB', 'IE'] }] },
    { country: 'US' },
  )
  bothRules(
    { conjunction: 'and', conditions: [{ field: 'employees', operator: 'between', value: ['10', '100'] }] },
    { employees: '50' },
  )
})

test('comparisons over numbers and dates', () => {
  bothRules({ conjunction: 'and', conditions: [{ field: 'employees', operator: 'gt', value: '10' }] }, { employees: '11' })
  bothRules({ conjunction: 'and', conditions: [{ field: 'employees', operator: 'lte', value: '10' }] }, { employees: '10' })
  bothRules(
    { conjunction: 'and', conditions: [{ field: 'renewal', operator: 'after', value: '2026-01-01' }] },
    { renewal: '2026-06-01' },
  )
  // Neither a number nor a date on one side: nothing to compare, so no match.
  bothRules({ conjunction: 'and', conditions: [{ field: 'employees', operator: 'gt', value: 'lots' }] }, { employees: '11' })
})

test('and needs every condition, or needs one', () => {
  const conditions = [
    { field: 'industry', operator: 'is', value: 'SaaS' },
    { field: 'country', operator: 'is', value: 'GB' },
  ]
  bothRules({ conjunction: 'and', conditions }, { industry: 'SaaS', country: 'US' })
  bothRules({ conjunction: 'or', conditions }, { industry: 'SaaS', country: 'US' })
  bothRules({ conjunction: 'and', conditions }, { industry: 'SaaS', country: 'GB' })
  bothRules({ conjunction: 'or', conditions }, { industry: 'Retail', country: 'US' })
})

test('a multi-select answer matches on any of its values', () => {
  const rule = { conjunction: 'and' as const, conditions: [{ field: 'interests', operator: 'is', value: 'pricing' }] }
  bothRules(rule, { interests: ['docs', 'pricing'] })
  bothRules(rule, { interests: ['docs'] })
  bothRules(rule, { interests: [] })
})

test('the public form asks a mapped question only while its property rule matches', () => {
  const fields: FormField[] = [
    field({ key: 'email', label: 'Email', type: 'email', required: true, mapsTo: 'contact.email' }),
    field({ key: 'industry', label: 'Industry', type: 'text', mapsTo: 'contact.industry' }),
    field({ key: 'seats', label: 'Seats', type: 'number', required: true, mapsTo: 'contact.seats' }),
  ]
  const rules = {
    'contact.seats': { conjunction: 'and' as const, conditions: [{ field: 'industry', operator: 'is' as const, value: 'SaaS' }] },
  }

  const hidden = validateAnswers(fields, { email: 'a@b.com', industry: 'Retail' }, rules)
  assert.deepEqual(hidden.errors, [], 'a question the rule hides is not demanded')

  const asked = validateAnswers(fields, { email: 'a@b.com', industry: 'SaaS' }, rules)
  assert.equal(asked.errors[0]?.key, 'seats', 'the same question is required once the rule matches')

  // Posted directly, past a form that never showed the field.
  const forced = validateAnswers(fields, { email: 'a@b.com', industry: 'Retail', seats: '40' }, rules)
  assert.equal(forced.answers.seats, undefined, 'an answer the rule hides is discarded, not written')
})
