import { checkOutboundUrl } from './outbound-policy.ts'
import { webAddress } from './form-schema.ts'
import type { IntegrationKind } from './integrations.ts'

/** What a config key must be before it is stored. Keys not listed here are kept as
 *  sent. The labels are the ones the connect form shows, so a refusal names the
 *  field the person is looking at. */
type ConfigRule = { label: string; required?: boolean } & (
  | { type: 'text' }
  | { type: 'whole' }
  | { type: 'url' }
  | { type: 'choice'; options: string[] }
  | { type: 'pattern'; pattern: RegExp; example: string }
)

const CONFIG_RULES: Partial<Record<IntegrationKind, Record<string, ConfigRule>>> = {
  brevo: { listId: { label: 'List id', type: 'whole' } },
  clay: {
    webhookUrl: { label: 'Table webhook URL', type: 'url', required: true },
    tier: { label: 'Plan tier', type: 'choice', options: ['launch', 'growth'] },
  },
  ga4: { measurementId: { label: 'Measurement id', type: 'pattern', pattern: /^G-[A-Z0-9]+$/i, example: 'G-XXXXXXX', required: true } },
  zoom: {
    accountId: { label: 'Account id', type: 'text', required: true },
    clientId: { label: 'Client id', type: 'text', required: true },
  },
  turnstile: { siteKey: { label: 'Site key', type: 'text', required: true } },
}

const wholeNumber = (text: string, label: string): number => {
  const number = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${label} has to be a whole number, such as 12.`)
  }
  return number
}

/** Reads a whole-number setting when a provider calls out, so a row saved before
 *  checkIntegrationConfig existed still works: its numeric text is parsed here.
 *  Absent means not set, and the caller decides what that means. */
export const readWholeConfig = (raw: unknown, label: string): number | null => {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string' && typeof raw !== 'number') throw new Error(`${label} has to be text or a number.`)
  return wholeNumber(String(raw).trim(), label)
}

const normalise = (rule: ConfigRule, text: string): string | number => {
  switch (rule.type) {
    case 'text':
      return text
    case 'whole':
      return wholeNumber(text, rule.label)
    case 'url': {
      if (!webAddress(text)) throw new Error(`${rule.label} has to be a full web address that starts with https://.`)
      try {
        return checkOutboundUrl(text)
      } catch (cause) {
        throw new Error(`${rule.label}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    case 'choice':
      if (!rule.options.includes(text)) throw new Error(`${rule.label} has to be one of: ${rule.options.join(', ')}.`)
      return text
    case 'pattern':
      if (!rule.pattern.test(text)) throw new Error(`${rule.label} has to look like ${rule.example}.`)
      return text
  }
}

/** Refuses a config a provider could not use, and returns it with the checked keys
 *  in their stored shape: a Brevo list id is a number, not the text the form sent. */
export const checkIntegrationConfig = (
  kind: IntegrationKind,
  config: Record<string, unknown>,
): Record<string, unknown> => {
  const checked = { ...config }
  for (const [key, rule] of Object.entries(CONFIG_RULES[kind] ?? {})) {
    const raw = config[key] ?? ''
    if (typeof raw !== 'string' && typeof raw !== 'number') throw new Error(`${rule.label} has to be text or a number.`)
    const text = String(raw).trim()
    if (text === '') {
      if (rule.required) throw new Error(`${rule.label} is required.`)
      delete checked[key]
    } else {
      checked[key] = normalise(rule, text)
    }
  }
  return checked
}
