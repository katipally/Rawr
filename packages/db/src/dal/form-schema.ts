import { matchesConditional, readConditional, type Conditional } from '../registry/conditional.ts'
import type { ObjectKey } from '../registry/core.ts'

/** The field types a form can offer. A subset of the registry's nineteen: a form
 *  asks a stranger questions, so `user`, `relation` and `rating` have no meaning
 *  here, and `hidden` exists only on forms, carrying a value the embed sets. */
export const FORM_FIELD_TYPES = [
  'text',
  'long_text',
  'email',
  'phone',
  'url',
  'select',
  'radio',
  'multi_select',
  'boolean',
  'consent',
  'number',
  'date',
  'file',
  'heading',
  'hidden',
] as const

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number]

const FORM_FIELD_TYPE_SET = new Set<string>(FORM_FIELD_TYPES)

export const isFormFieldType = (value: string): value is FormFieldType =>
  FORM_FIELD_TYPE_SET.has(value)

/** Types that offer a fixed list, so a schema without options is unanswerable. */
export const CHOICE_TYPES = new Set<FormFieldType>(['select', 'radio', 'multi_select'])

/** Types that ask nothing. A heading is page furniture: it never posts a value,
 *  never validates, and never maps to a record field. Kept in the field list
 *  rather than in settings so it can be ordered and stepped like everything
 *  else a marketer drags around. */
export const DISPLAY_TYPES = new Set<FormFieldType>(['heading'])

/** One level of conditional visibility. Nesting is explicitly out of scope: it
 *  turns a form builder into a rules engine and nobody asked for one. */
export type VisibleIf = { field: string; equals: string }

export type FormFieldValidation = {
  regex?: string
  min?: number
  max?: number
  minLength?: number
  maxLength?: number
}

export type FormField = {
  key: string
  type: FormFieldType
  label: string
  placeholder?: string | undefined
  help?: string | undefined
  required: boolean
  /** For select and multi_select. */
  options?: { value: string; label: string }[] | undefined
  validation?: FormFieldValidation | undefined
  visibleIf?: VisibleIf | undefined
  /** Which registry field this answer becomes, e.g. "contact.email". Null means
   *  the answer is stored in `values` and nowhere else, which is deliberate: no
   *  data is lost while somebody decides what the field means. */
  mapsTo?: `${ObjectKey}.${string}` | null | undefined
  /** Multi-step: which step this field appears on, zero based. */
  step?: number | undefined
  /** hidden fields only: the value the embed sets when the page does not supply one. */
  defaultValue?: string | undefined
}

/** The custom properties the embed stylesheet reads. A form's look is these and
 *  nothing else, which is what lets a marketer re-theme a form without a deploy
 *  and without a stylesheet of overrides fighting ours. */
export const FORM_THEME_TOKENS = [
  'font',
  'text',
  'muted',
  'border',
  'focus',
  'cta',
  'cta-text',
  'error',
  'radius',
  'gap',
  'field-bg',
  'field-border-width',
] as const

export type FormThemeToken = (typeof FORM_THEME_TOKENS)[number]

/** A named starting point plus whatever the marketer changed on top of it. */
export type FormTheme = {
  preset: string
  tokens: Partial<Record<FormThemeToken, string>>
}

/** A token value ends up inside a CSS declaration, so it must not be able to
 *  close one. Anything that could start a new rule, call a URL or open a comment
 *  is dropped rather than escaped: the values here are colours and lengths, and
 *  none of them need those characters. */
const CLEAN_TOKEN = /^[a-zA-Z0-9#%(),.\s_+/-]{1,80}$/
const isCleanToken = (value: string): boolean =>
  CLEAN_TOKEN.test(value) && !/url\(|@import|expression/i.test(value)

export const readTheme = (raw: unknown): FormTheme => {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const given = (t.tokens && typeof t.tokens === 'object' ? t.tokens : {}) as Record<string, unknown>
  const tokens: Partial<Record<FormThemeToken, string>> = {}
  for (const name of FORM_THEME_TOKENS) {
    const value = given[name]
    if (typeof value === 'string' && isCleanToken(value)) tokens[name] = value
  }
  return {
    preset: typeof t.preset === 'string' && /^[a-z-]{1,32}$/.test(t.preset) ? t.preset : 'neutral',
    tokens,
  }
}

export type FormSettings = {
  submitLabel: string
  successMode: 'message' | 'redirect'
  successValue: string
  notifySlack: boolean
  slackChannel?: string | null | undefined
  lifecycleStageOnSubmit?: string | null | undefined
  subscriptionOptIns?: string[] | undefined
  /** Step labels, used for the progress indicator. One entry per step. */
  steps?: string[] | undefined
  /** How the rendered form looks. Stored as a choice, not as CSS: the values
   *  live with the stylesheet that reads them. */
  theme?: FormTheme | undefined
  /** Who a new lead belongs to. 'user' names one person; 'round_robin' shares
   *  them across the pool, or across every super admin and every seat that can
   *  edit the sales hub when the pool is empty. Either way the seat has to still
   *  be active. A contact that already has an owner keeps them. */
  assignOwner?: AssignOwner | undefined
}

export type AssignOwner = { mode: 'none' | 'user' | 'round_robin'; userId?: string | null | undefined; pool?: string[] | undefined }

export const readAssignOwner = (raw: unknown): AssignOwner => {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const mode = a.mode === 'user' || a.mode === 'round_robin' ? a.mode : 'none'
  return {
    mode,
    userId: typeof a.userId === 'string' && a.userId ? a.userId : null,
    pool: Array.isArray(a.pool) ? a.pool.filter((v): v is string => typeof v === 'string') : [],
  }
}

export const DEFAULT_SETTINGS: FormSettings = {
  submitLabel: 'Submit',
  successMode: 'message',
  successValue: 'Thanks. Someone will be in touch shortly.',
  notifySlack: true,
  slackChannel: null,
  lifecycleStageOnSubmit: null,
  subscriptionOptIns: [],
  theme: { preset: 'neutral', tokens: {} },
  assignOwner: { mode: 'none', userId: null, pool: [] },
}

/** The honeypot's name has to look like something a bot wants to fill and nothing
 *  a password manager or a browser autofill will touch. A field literally called
 *  "website" is filled by autofill often enough to burn real people. */
export const HONEYPOT_FIELD = 'rawr_hp_company_url'

/** Rendered into the form and echoed back, so the server can tell how long the
 *  page was open without keeping per-render state. */
export const TIMING_FIELD = 'rawr_t'

/** Keys the embed and the hosted page send alongside the answers: the raw query
 *  string, referrer, landing page, current path and visitor id that D17's
 *  attribution container is built from. */
export const ATTRIBUTION_FIELDS = {
  rawQuery: 'rawr_q',
  referrer: 'rawr_ref',
  landingPage: 'rawr_landing',
  pagePath: 'rawr_page',
  visitorId: 'rawr_vid',
} as const

/** Reserved keys the schema may never use, because the submit path reads them as
 *  control data rather than as answers. A posted key in this set is skipped by
 *  the allowlist instead of being refused as an unknown field. */
export const FORM_RESERVED_KEYS = new Set<string>([
  HONEYPOT_FIELD,
  TIMING_FIELD,
  'cf-turnstile-response',
  ...Object.values(ATTRIBUTION_FIELDS),
])

const KEY_PATTERN = /^[a-z][a-z0-9_]{0,58}$/

export class FormSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FormSchemaError'
  }
}

/** Parses whatever is in the jsonb column into fields we can trust. A form saved
 *  by an older build, or hand-edited, must not crash the public page: an
 *  unreadable field is dropped and the rest of the form still renders. */
export const readSchema = (raw: unknown): FormField[] => {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const f = entry as Record<string, unknown>
    const key = typeof f.key === 'string' ? f.key : ''
    const type = typeof f.type === 'string' && isFormFieldType(f.type) ? f.type : null
    if (!KEY_PATTERN.test(key) || !type || FORM_RESERVED_KEYS.has(key)) return []
    return [
      {
        key,
        type,
        label: typeof f.label === 'string' && f.label ? f.label : key,
        placeholder: typeof f.placeholder === 'string' ? f.placeholder : undefined,
        help: typeof f.help === 'string' ? f.help : undefined,
        required: f.required === true,
        options: Array.isArray(f.options)
          ? f.options.flatMap((o) => {
              const opt = o as Record<string, unknown>
              const value = typeof opt?.value === 'string' ? opt.value : null
              if (value === null) return []
              return [{ value, label: typeof opt.label === 'string' ? opt.label : value }]
            })
          : undefined,
        validation:
          f.validation && typeof f.validation === 'object'
            ? (f.validation as FormFieldValidation)
            : undefined,
        visibleIf:
          f.visibleIf && typeof f.visibleIf === 'object'
            ? (f.visibleIf as VisibleIf)
            : undefined,
        mapsTo: typeof f.mapsTo === 'string' ? (f.mapsTo as FormField['mapsTo']) : null,
        step: typeof f.step === 'number' && f.step >= 0 ? Math.floor(f.step) : 0,
        defaultValue: typeof f.defaultValue === 'string' ? f.defaultValue : undefined,
      },
    ]
  })
}

export const readSettings = (raw: unknown): FormSettings => {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    submitLabel:
      typeof s.submitLabel === 'string' && s.submitLabel
        ? s.submitLabel
        : DEFAULT_SETTINGS.submitLabel,
    successMode: s.successMode === 'redirect' ? 'redirect' : 'message',
    successValue:
      typeof s.successValue === 'string' && s.successValue
        ? s.successValue
        : DEFAULT_SETTINGS.successValue,
    notifySlack: s.notifySlack !== false,
    slackChannel: typeof s.slackChannel === 'string' ? s.slackChannel : null,
    lifecycleStageOnSubmit:
      typeof s.lifecycleStageOnSubmit === 'string' ? s.lifecycleStageOnSubmit : null,
    subscriptionOptIns: Array.isArray(s.subscriptionOptIns)
      ? s.subscriptionOptIns.filter((v): v is string => typeof v === 'string')
      : [],
    steps: Array.isArray(s.steps)
      ? s.steps.filter((v): v is string => typeof v === 'string')
      : undefined,
    theme: readTheme(s.theme),
    assignOwner: readAssignOwner(s.assignOwner),
  }
}

/** The address a form is served at: /form/<account>/<slug>. */
export const FORM_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

export const toFormSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)

/** Every reason this form cannot be saved, in the order a person fixes them.
 *  Empty means saveable.
 *
 *  Returned as a list rather than thrown one at a time so the builder can say
 *  all of it before the click. Creating a form used to be four blind saves:
 *  each rule only spoke once the one before it was satisfied. */
export const formBlockers = (input: {
  name: string
  slug: string
  fields: FormField[]
}): string[] => {
  const blockers: string[] = []
  if (!input.name.trim()) blockers.push('A form needs a name.')
  if (!FORM_SLUG.test(input.slug)) {
    blockers.push(
      input.slug
        ? `"${input.slug}" is not a usable address. Use lowercase letters, numbers and hyphens.`
        : 'A form needs an address. It is the last part of the link people open.',
    )
  }
  return [...blockers, ...schemaBlockers(input.fields)]
}

/** The schema half of the same list: what the submit path could not honour.
 *
 *  `asksEmail` says the caller already collects an address of its own: a booking
 *  page always asks for a name and a work email beside its extra questions. */
export const schemaBlockers = (fields: FormField[], asksEmail = false): string[] => {
  if (fields.length === 0) return ['A form needs at least one field.']

  const blockers: string[] = []
  const seen = new Set<string>()
  for (const field of fields) {
    if (!KEY_PATTERN.test(field.key)) {
      blockers.push(
        `"${field.key}" is not a usable field key. Use lowercase letters, numbers and underscores, starting with a letter.`,
      )
    }
    if (FORM_RESERVED_KEYS.has(field.key)) {
      blockers.push(`"${field.key}" is reserved by the submit path. Pick another key.`)
    }
    if (seen.has(field.key)) {
      blockers.push(`Two fields both use the key "${field.key}". Keys must be unique.`)
    }
    seen.add(field.key)

    if (CHOICE_TYPES.has(field.type) && !field.options?.length) {
      blockers.push(`"${field.label}" is a choice field with no options to choose from.`)
    }
    if (field.validation?.regex) {
      try {
        new RegExp(field.validation.regex)
      } catch {
        blockers.push(`"${field.label}" has a validation pattern Postgres cannot read.`)
      }
    }
  }

  for (const field of fields) {
    const condition = field.visibleIf
    if (!condition) continue
    if (!seen.has(condition.field)) {
      blockers.push(
        `"${field.label}" is shown based on "${condition.field}", which is not a field on this form.`,
      )
    }
    if (condition.field === field.key) {
      blockers.push(`"${field.label}" cannot be shown based on its own answer.`)
    }
  }

  /** Without an email there is nothing to dedupe a contact on, so every submission
   *  would create a new person. F1 A4 makes lower(email) the contact key. */
  if (!asksEmail && !fields.some((f) => f.type === 'email')) {
    blockers.push(
      'A form needs an email field. Without one, every submission creates a new contact instead of updating one.',
    )
  }
  return blockers
}

/** Refuses a schema a person could build but the submit path could not honour.
 *  Called on save, so a broken form never reaches the public edge. */
export const assertSchemaIsUsable = (fields: FormField[], asksEmail = false): void => {
  const [first] = schemaBlockers(fields, asksEmail)
  if (first) throw new FormSchemaError(first)
}

/** Whether a field should be asked, given the answers so far. The server re-runs
 *  this rather than trusting the client, so a hidden required field cannot be
 *  forced by posting directly, and an answer to an invisible field is discarded. */
export const isVisible = (field: FormField, answers: Record<string, unknown>): boolean => {
  const condition = field.visibleIf
  if (!condition) return true
  const actual = answers[condition.field]
  if (Array.isArray(actual)) return actual.map(String).includes(condition.equals)
  return String(actual ?? '') === condition.equals
}

/** The conditional rules on the properties this form writes to, keyed the way a
 *  field names its target: "contact.industry".
 *
 *  Resolved with the form rather than stored on it. A rule belongs to the
 *  property, so a marketer who changes it in settings changes every form that
 *  asks for that property, which is the whole point of the rule living there. */
export type PropertyRules = Record<string, Conditional>

export const readPropertyRules = (raw: unknown): PropertyRules => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const rules: PropertyRules = {}
  for (const [target, value] of Object.entries(raw as Record<string, unknown>)) {
    const rule = readConditional(value)
    if (rule) rules[target] = rule
  }
  return rules
}

/** A rule names sibling properties, not form fields, so the answers have to be
 *  re-keyed before it can be evaluated: one map per object, keyed by property. */
const byProperty = (
  fields: FormField[],
  answers: Record<string, unknown>,
): Record<string, Record<string, unknown>> => {
  const objects: Record<string, Record<string, unknown>> = {}
  for (const field of fields) {
    const target = field.mapsTo?.split('.')
    if (!target || target.length !== 2) continue
    const [object, property] = target as [string, string]
    objects[object] ??= {}
    ;(objects[object] as Record<string, unknown>)[property] = answers[field.key]
  }
  return objects
}

/** Whether a form asks this field at all, given the answers so far.
 *
 *  Two rules, both re-run on the server rather than trusted: the form's own
 *  `visibleIf`, and the conditional logic on the property the answer becomes.
 *  A property whose rule references something this form never asks is compared
 *  against an empty answer, which is what it is: the form did not collect it. */
export const askedFields = (
  fields: FormField[],
  answers: Record<string, unknown>,
  rules: PropertyRules,
): FormField[] => {
  const values = Object.keys(rules).length > 0 ? byProperty(fields, answers) : {}
  return fields.filter((field) => {
    if (!isVisible(field, answers)) return false
    const rule = field.mapsTo ? rules[field.mapsTo] : undefined
    if (!rule) return true
    const [object = ''] = field.mapsTo?.split('.') ?? []
    return matchesConditional(rule, values[object] ?? {})
  })
}
