import type { FormField, FormFieldType } from '@rawr/db'

/** What a no-JS visitor typed, carried across the redirect that shows their
 *  validation errors. A cookie rather than the URL, because a URL lands in
 *  history, access logs and the next page's Referer.
 *
 *  Short lived and read back as untrusted input: it is checked against the form's
 *  own fields, so a hand-made cookie can fill a box the form has and nothing else. */

export const ECHO_MAX_AGE_SECONDS = 120

/** One typed answer. Matches what the form accepted before this moved off the URL. */
const MAX_VALUE = 200

/** Encoded size of the whole cookie. Browsers drop a cookie past 4096 bytes
 *  including its name and attributes, so this leaves room for both. */
const MAX_ENCODED = 3000

/** Only types the page prefills from a typed string. A file never posts a value
 *  without script, and a hidden field was never typed. */
const ECHOED = new Set<FormFieldType>([
  'text', 'long_text', 'email', 'phone', 'url', 'select', 'radio', 'number', 'date',
])

/** Nothing secret is asked for by a form builder with no password type, but a
 *  text field can be labelled as one, and that must not sit in a cookie. */
const SENSITIVE = /pass|pwd|secret|token|ssn|cvv|card.?num/i

const echoable = (field: FormField): boolean =>
  ECHOED.has(field.type) && !SENSITIVE.test(`${field.key} ${field.label}`)

export const echoCookieName = (formId: string): string => `rawr_echo_${formId}`

/** The page path a cookie is scoped to, or null for anything that is not a form
 *  address: the path arrives in a hidden input, so it is caller supplied. */
export const echoCookiePath = (path: string): string | null =>
  /^[\w~-][\w.~-]*(\/[\w~-][\w.~-]*)?$/.test(path) ? `/form/${path}` : null

/** O(fields), and stops at the first answer that would overflow the cookie. */
export const encodeEcho = (fields: FormField[], body: Record<string, unknown>): string | null => {
  const kept: Record<string, string> = {}
  for (const field of fields) {
    const value = body[field.key]
    if (!echoable(field) || typeof value !== 'string' || value === '') continue
    kept[field.key] = value.slice(0, MAX_VALUE)
    if (encodeURIComponent(JSON.stringify(kept)).length > MAX_ENCODED) {
      delete kept[field.key]
      break
    }
  }
  return Object.keys(kept).length > 0 ? JSON.stringify(kept) : null
}

export const decodeEcho = (fields: FormField[], raw: string | undefined): Record<string, string> => {
  if (!raw || raw.length > MAX_ENCODED) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const typed = parsed as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const field of fields) {
    const value = typed[field.key]
    if (echoable(field) && typeof value === 'string') out[field.key] = value.slice(0, MAX_VALUE)
  }
  return out
}
