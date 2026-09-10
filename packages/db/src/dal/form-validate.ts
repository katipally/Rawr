import { normaliseEmail } from './domains.ts'
import {
  askedFields,
  DISPLAY_TYPES,
  FORM_RESERVED_KEYS,
  type FormField,
  type PropertyRules,
} from './form-schema.ts'

export type FieldError = { key: string; message: string }

export type Validated = {
  answers: Record<string, unknown>
  errors: FieldError[]
}

/** Longest a single answer may be. A form is not a file upload, and an unbounded
 *  textarea is how a table gets filled with someone's idea of a joke. */
const MAX_ANSWER = 5000
const MAX_OPTIONS_CHOSEN = 50

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const asString = (raw: unknown): string => {
  if (Array.isArray(raw)) return String(raw[0] ?? '')
  if (raw === null || raw === undefined) return ''
  return String(raw)
}

const asList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.map((v) => String(v))
  const single = asString(raw)
  return single ? [single] : []
}

/** Validates a posted body against the form's own schema and nothing else.
 *
 *  Two rules matter more than the individual checks. Unknown keys are refused
 *  rather than stored, so a bot cannot append fields of its own. And visibility
 *  is recomputed here rather than trusted, so a required field hidden by a
 *  condition is not demanded, and an answer to a field that should not have been
 *  on screen is discarded instead of written.
 *
 *  Visibility is both the form's own `visibleIf` and the conditional rule on the
 *  property the answer becomes: a property the record panel would not show for
 *  these values is not one a stranger can fill in by posting directly. */
export const validateAnswers = (
  fields: FormField[],
  body: Record<string, unknown>,
  rules: PropertyRules = {},
): Validated => {
  const errors: FieldError[] = []
  const answers: Record<string, unknown> = {}
  const known = new Map(fields.map((field) => [field.key, field]))

  for (const key of Object.keys(body)) {
    if (FORM_RESERVED_KEYS.has(key)) continue
    if (!known.has(key)) {
      errors.push({ key, message: `"${key}" is not a field on this form.` })
    }
  }
  if (errors.length > 0) return { answers, errors }

  // Two passes: visibility depends on other answers, so every answer is read
  // first and only then filtered by the conditions those answers imply.
  const raw: Record<string, unknown> = {}
  for (const field of fields) {
    if (DISPLAY_TYPES.has(field.type)) continue
    if (field.type === 'multi_select') raw[field.key] = asList(body[field.key])
    else raw[field.key] = asString(body[field.key] ?? field.defaultValue ?? '')
  }

  for (const field of askedFields(fields, raw, rules)) {
    if (DISPLAY_TYPES.has(field.type)) continue
    const value = raw[field.key]
    const error = checkField(field, value)
    if (error) {
      errors.push({ key: field.key, message: error })
      continue
    }
    const empty = Array.isArray(value) ? value.length === 0 : String(value ?? '') === ''
    if (!empty) answers[field.key] = normalise(field, value)
  }

  return { answers, errors }
}

const checkField = (field: FormField, value: unknown): string | null => {
  const list = Array.isArray(value) ? value : null
  const text = list ? '' : String(value ?? '')
  const empty = list ? list.length === 0 : text.trim() === ''

  if (empty) return field.required ? `${field.label} is required.` : null

  if (list && list.length > MAX_OPTIONS_CHOSEN) {
    return `${field.label} has too many choices selected.`
  }
  if (!list && text.length > MAX_ANSWER) {
    return `${field.label} is longer than ${MAX_ANSWER} characters.`
  }

  const rules = field.validation
  if (rules?.minLength && text.length < rules.minLength) {
    return `${field.label} must be at least ${rules.minLength} characters.`
  }
  if (rules?.maxLength && text.length > rules.maxLength) {
    return `${field.label} must be ${rules.maxLength} characters or fewer.`
  }
  if (rules?.regex) {
    try {
      if (!new RegExp(rules.regex).test(text)) return `${field.label} is not in the expected format.`
    } catch {
      // A pattern that no longer compiles must not block a real person. The
      // builder refuses to save one, so this is only reachable via hand-editing.
    }
  }

  switch (field.type) {
    case 'email':
      if (!normaliseEmail(text)) return `${field.label} is not an email address.`
      break
    case 'number': {
      const n = Number(text)
      if (!Number.isFinite(n)) return `${field.label} must be a number.`
      if (rules?.min !== undefined && n < rules.min) return `${field.label} must be at least ${rules.min}.`
      if (rules?.max !== undefined && n > rules.max) return `${field.label} must be at most ${rules.max}.`
      break
    }
    case 'date':
      if (Number.isNaN(Date.parse(text))) return `${field.label} is not a date.`
      break
    case 'url':
      try {
        new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
      } catch {
        return `${field.label} is not a web address.`
      }
      break
    case 'phone':
      if (!/^[+0-9][0-9\s().-]{4,30}$/.test(text)) return `${field.label} is not a phone number.`
      break
    case 'select':
    case 'radio':
      if (field.options && !field.options.some((o) => o.value === text)) {
        return `${field.label} is not one of the available choices.`
      }
      break
    // The value is the id of an upload this form already accepted. Shape only
    // here; that it belongs to this form is settled against the row on submit,
    // because a posted id is a claim and only the table can confirm it.
    case 'file':
      if (!UPLOAD_ID.test(text)) return `${field.label} was not uploaded successfully. Try again.`
      break
    case 'multi_select':
      if (field.options && list) {
        const allowed = new Set(field.options.map((o) => o.value))
        const bad = list.find((v) => !allowed.has(v))
        if (bad) return `${field.label} does not offer "${bad}" as a choice.`
      }
      break
    default:
      break
  }
  return null
}

const normalise = (field: FormField, value: unknown): unknown => {
  if (field.type === 'multi_select') return value
  const text = String(value ?? '').trim()
  if (field.type === 'email') return normaliseEmail(text) ?? text
  if (field.type === 'boolean' || field.type === 'consent') {
    return text === 'true' || text === 'on' || text === '1'
  }
  if (field.type === 'number') return Number(text)
  return text
}

/** The email a submission dedupes a contact on. Without one the whole upsert has
 *  no key, which is why the builder refuses to save a form that lacks one. */
export const emailFrom = (
  fields: FormField[],
  answers: Record<string, unknown>,
): string | null => {
  const field = fields.find((f) => f.type === 'email')
  if (!field) return null
  return normaliseEmail(String(answers[field.key] ?? ''))
}
