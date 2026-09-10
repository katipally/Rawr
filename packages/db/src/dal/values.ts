import { MAX_TEXT_LENGTH, type FieldType } from '../registry/types.ts'
import { normaliseEmail, registrableDomain } from './domains.ts'
import type { RegistryField } from './registry.ts'

export class ValueError extends Error {
  readonly fieldKey: string
  constructor(field: RegistryField, detail: string) {
    super(`${field.label}: ${detail}`)
    this.name = 'ValueError'
    this.fieldKey = field.key
  }
}

export type Coerced = { value: unknown; warning?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

const truncate = (field: RegistryField, value: string): Coerced => {
  const max = MAX_TEXT_LENGTH[field.type]
  if (max === undefined || value.length <= max) return { value }
  // A 40,000-character cell is a warning on that row, not a failed import. A8.
  return {
    value: value.slice(0, max),
    warning: `${field.label} was ${value.length} characters and was cut to ${max}.`,
  }
}

const number = (field: RegistryField, input: unknown): Coerced => {
  const raw = typeof input === 'string' ? input.replace(/[,\s]/g, '').replace(/^[$€£]/, '') : input
  const parsed = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(parsed)) throw new ValueError(field, `"${String(input)}" is not a number.`)
  return { value: parsed }
}

/** Accepts what a spreadsheet actually produces: ISO, US and European orders, and
 *  a Date. Anything ambiguous is refused rather than guessed, because a silently
 *  wrong close date is worse than a rejected row. */
const toDate = (field: RegistryField, input: unknown): string => {
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime())) throw new ValueError(field, 'is not a real date.')
    return input.toISOString().slice(0, 10)
  }
  const text = String(input).trim()
  if (DATE.test(text)) {
    const parsed = new Date(`${text}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime())) throw new ValueError(field, `"${text}" is not a real date.`)
    return text
  }
  const slash = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/)
  if (slash) {
    const [, a, b, year] = slash
    const first = Number(a)
    const second = Number(b)
    // Unambiguous only when one part cannot be a month.
    if (first > 12 && second <= 12) return `${year}-${String(second).padStart(2, '0')}-${String(first).padStart(2, '0')}`
    if (second > 12 && first <= 12) return `${year}-${String(first).padStart(2, '0')}-${String(second).padStart(2, '0')}`
    throw new ValueError(
      field,
      `"${text}" could be day/month or month/day. Use YYYY-MM-DD so it cannot be read the wrong way round.`,
    )
  }
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) throw new ValueError(field, `"${text}" is not a date.`)
  return parsed.toISOString().slice(0, 10)
}

const BOOLEAN_TRUE = new Set(['true', 't', 'yes', 'y', '1', 'on'])
const BOOLEAN_FALSE = new Set(['false', 'f', 'no', 'n', '0', 'off'])

/** The one place a value entering the database is checked against its declared
 *  type. Inline edit, the record form, the importer and the MCP tools all call it,
 *  so none of them can accept something the others would refuse. */
export const coerce = (field: RegistryField, input: unknown): Coerced => {
  if (input === null || input === undefined || input === '') {
    if (field.isRequired) throw new ValueError(field, 'is required and cannot be emptied.')
    return { value: null }
  }

  switch (field.type) {
    // A single line is stored as a single line. A name pasted out of a spreadsheet
    // arrives with tabs in it, which render as spaces, so the record then reads one
    // way and compares another -- and a delete that asks you to type the name back
    // can never be satisfied.
    case 'text':
      return truncate(field, String(input).replace(/\s+/g, ' ').trim())

    case 'long_text':
    case 'address':
      return truncate(field, String(input).trim())

    // Markdown is text, and stored as the person typed it. Nothing is stripped
    // here: it is rendered to React elements rather than to markup, so there is
    // no tag that could survive into a page and nothing to sanitise against.
    case 'rich_text':
      return truncate(field, String(input).trimEnd())

    case 'number':
    case 'currency':
    case 'percent':
    case 'rating': {
      const coerced = number(field, input)
      if (field.type === 'percent' && (Number(coerced.value) < 0 || Number(coerced.value) > 100)) {
        throw new ValueError(field, 'is a percentage, so it has to be between 0 and 100.')
      }
      if (field.type === 'rating' && (Number(coerced.value) < 0 || Number(coerced.value) > 5)) {
        throw new ValueError(field, 'is a rating from 0 to 5.')
      }
      return coerced
    }

    case 'boolean': {
      if (typeof input === 'boolean') return { value: input }
      const text = String(input).trim().toLowerCase()
      if (BOOLEAN_TRUE.has(text)) return { value: true }
      if (BOOLEAN_FALSE.has(text)) return { value: false }
      throw new ValueError(field, `"${String(input)}" is not a yes or a no.`)
    }

    case 'date':
      return { value: toDate(field, input) }

    case 'datetime': {
      const parsed = input instanceof Date ? input : new Date(String(input))
      if (Number.isNaN(parsed.getTime())) {
        throw new ValueError(field, `"${String(input)}" is not a date and time.`)
      }
      return { value: parsed }
    }

    case 'select': {
      const text = String(input).trim()
      if (field.options.length > 0 && !field.options.includes(text)) {
        throw new ValueError(
          field,
          `"${text}" is not one of its choices: ${field.options.join(', ')}.`,
        )
      }
      return truncate(field, text)
    }

    case 'multi_select': {
      const list = Array.isArray(input)
        ? input.map((v) => String(v).trim())
        : String(input).split(';').map((v) => v.trim())
      const values = [...new Set(list.filter(Boolean))]
      if (field.options.length > 0) {
        const unknown = values.filter((v) => !field.options.includes(v))
        if (unknown.length > 0) {
          throw new ValueError(field, `${unknown.join(', ')} are not among its choices.`)
        }
      }
      return { value: values }
    }

    case 'email': {
      const email = normaliseEmail(String(input))
      if (!email) throw new ValueError(field, `"${String(input)}" is not an email address.`)
      return truncate(field, email)
    }

    case 'phone':
      return truncate(field, String(input).trim())

    case 'url': {
      // A company domain is stored as its registrable domain, never as a URL, so
      // "https://WWW.Acme.com/pricing" and "acme.com" are the same company.
      if (field.key === 'domain') {
        const domain = registrableDomain(String(input))
        if (!domain) throw new ValueError(field, `"${String(input)}" is not a domain.`)
        return { value: domain }
      }
      return truncate(field, String(input).trim())
    }

    case 'linkedin': {
      const text = String(input).trim()
      if (text && !/^https?:\/\//i.test(text) && !text.includes('linkedin.com')) {
        return truncate(field, `https://www.linkedin.com/in/${text.replace(/^\/+/, '')}`)
      }
      return truncate(field, text)
    }

    case 'user':
    case 'relation': {
      const text = String(input).trim()
      if (!UUID.test(text)) {
        throw new ValueError(field, 'has to be picked from the list, not typed.')
      }
      return { value: text }
    }

    case 'json':
      if (typeof input === 'string') {
        try {
          return { value: JSON.parse(input) }
        } catch {
          throw new ValueError(field, 'is not valid JSON.')
        }
      }
      return { value: input }
  }
}

/** How a value leaves Rawr: one rule per type, used by CSV export and by anything
 *  that has to render a value as plain text. */
export const formatForCsv = (type: FieldType, value: unknown): string => {
  if (value === null || value === undefined) return ''
  switch (type) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'multi_select':
      return Array.isArray(value) ? value.join(';') : String(value)
    case 'datetime':
      return value instanceof Date ? value.toISOString() : String(value)
    case 'json':
      return typeof value === 'object' ? JSON.stringify(value) : String(value)
    default:
      return String(value)
  }
}
