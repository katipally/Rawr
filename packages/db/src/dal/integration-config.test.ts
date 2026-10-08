import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkIntegrationConfig, readWholeConfig } from './integration-config.ts'

const refusal = (kind: Parameters<typeof checkIntegrationConfig>[0], config: Record<string, unknown>) => {
  try {
    checkIntegrationConfig(kind, config)
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
  assert.fail(`${JSON.stringify(config)} was accepted`)
}

test('a Brevo list id is stored as a number, whether sent as text or as a number', () => {
  assert.equal(checkIntegrationConfig('brevo', { listId: '12' }).listId, 12)
  assert.equal(checkIntegrationConfig('brevo', { listId: 42 }).listId, 42)
  assert.equal(checkIntegrationConfig('brevo', { listId: ' 7 ' }).listId, 7)
})

test('a list id that is not a positive whole number is refused by name', () => {
  for (const listId of ['abc', '12.5', '-3', '0', '1e3', '99999999999999999999']) {
    assert.equal(refusal('brevo', { listId }), 'List id has to be a whole number, such as 12.', listId)
  }
  assert.equal(refusal('brevo', { listId: true }), 'List id has to be text or a number.')
})

test('a list id saved as text before the check existed is read as a number at call time', () => {
  assert.equal(readWholeConfig('43', 'List id'), 43)
  assert.equal(readWholeConfig(' 43 ', 'List id'), 43)
  assert.equal(readWholeConfig(43, 'List id'), 43)
  assert.equal(readWholeConfig(undefined, 'List id'), null)
  assert.equal(readWholeConfig(null, 'List id'), null)
})

test('a stored list id that is not a whole number is refused at call time, by name', () => {
  for (const listId of ['abc', '12.5', '-3', '0', '', '1e3', 0.5, 1e21]) {
    assert.throws(() => readWholeConfig(listId, 'List id'), { message: 'List id has to be a whole number, such as 12.' }, String(listId))
  }
  assert.throws(() => readWholeConfig({ id: 1 }, 'List id'), { message: 'List id has to be text or a number.' })
})

test('an empty optional key is dropped, not stored as blank', () => {
  assert.deepEqual(checkIntegrationConfig('brevo', { listId: '  ', subscriptionType: 'Newsletter' }), {
    subscriptionType: 'Newsletter',
  })
})

test('a required key left blank is refused by its label', () => {
  assert.equal(refusal('zoom', { accountId: 'acc', clientId: '   ' }), 'Client id is required.')
  assert.equal(refusal('turnstile', {}), 'Site key is required.')
  assert.equal(refusal('ga4', {}), 'Measurement id is required.')
})

test('a Clay webhook URL must be a full https address, and a private one is refused', () => {
  const ok = checkIntegrationConfig('clay', { webhookUrl: 'https://api.clay.com/v3/sources/abc' })
  assert.equal(ok.webhookUrl, 'https://api.clay.com/v3/sources/abc')
  assert.equal(
    refusal('clay', { webhookUrl: 'not a url' }),
    'Table webhook URL has to be a full web address that starts with https://.',
  )
  assert.equal(
    refusal('clay', { webhookUrl: 'javascript:alert(1)' }),
    'Table webhook URL has to be a full web address that starts with https://.',
  )
  assert.match(refusal('clay', { webhookUrl: 'https://169.254.169.254/latest' }), /^Table webhook URL: /)
})

test('a plan tier outside the two Clay offers is refused with the choices', () => {
  assert.equal(refusal('clay', { webhookUrl: 'https://api.clay.com/x', tier: 'enterprise' }), 'Plan tier has to be one of: launch, growth.')
  assert.equal(checkIntegrationConfig('clay', { webhookUrl: 'https://api.clay.com/x', tier: 'launch' }).tier, 'launch')
})

test('a GA4 measurement id has to look like G-XXXXXXX', () => {
  assert.equal(refusal('ga4', { measurementId: 'NOT-A-GA4-ID' }), 'Measurement id has to look like G-XXXXXXX.')
  assert.equal(checkIntegrationConfig('ga4', { measurementId: 'G-AB12CD' }).measurementId, 'G-AB12CD')
})

test('keys with no rule, and kinds with no config, pass through as sent', () => {
  assert.deepEqual(checkIntegrationConfig('slack', { channel: '#sales-leads', stageAlerts: 'Enterprise' }), {
    channel: '#sales-leads',
    stageAlerts: 'Enterprise',
  })
  assert.deepEqual(checkIntegrationConfig('lusha', { anything: 1 }), { anything: 1 })
})
