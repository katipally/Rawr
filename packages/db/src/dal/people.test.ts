import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FormField } from './form-schema.ts'
import { mappedKeyIsWritable, mapAnswersToColumns } from './people.ts'

const field = (key: string, mapsTo: FormField['mapsTo']): FormField =>
  ({ key, label: key, type: 'text', required: false, mapsTo })

test('a stranger answer never writes a system field or the marketing status', () => {
  const fields = [
    field('created', 'contact.created_at'),
    field('sent', 'contact.emails_sent'),
    field('status', 'contact.marketing_status'),
    field('score', 'company.score'),
    field('title', 'contact.title'),
  ]
  const answers = { created: '2001-01-01', sent: '99', status: 'Marketing contact', score: '5', title: 'CTO' }
  assert.deepEqual(mapAnswersToColumns(fields, answers), { contact: { title: 'CTO' }, company: {} })
})

test('only keys the system does not own are writable', () => {
  assert.equal(mappedKeyIsWritable('created_at'), false)
  assert.equal(mappedKeyIsWritable('emails_received'), false)
  assert.equal(mappedKeyIsWritable('marketing_status'), false)
  assert.equal(mappedKeyIsWritable('title'), true)
})
