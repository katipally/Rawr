import type { fieldTypeEnum } from '../schema/enums.ts'

export type FieldType = (typeof fieldTypeEnum.enumValues)[number]

/** The operator vocabulary. Every filter anywhere in Rawr is one of these, so the
 *  builder, the query compiler, the segment evaluator and the MCP tool schema all
 *  speak the same language. */
export const OPERATORS = [
  'is',
  'is_not',
  'contains',
  'not_contains',
  'starts_with',
  'is_empty',
  'is_not_empty',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'in',
  'not_in',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
] as const

export type Operator = (typeof OPERATORS)[number]

/** Operators that take no value at all. The builder hides the value input for these
 *  and the compiler refuses a value if one is sent anyway. */
export const NULLARY_OPERATORS: readonly Operator[] = ['is_empty', 'is_not_empty']

/** Operators that take a list rather than a scalar. */
export const LIST_OPERATORS: readonly Operator[] = ['in', 'not_in', 'between']

const TEXTUAL: readonly Operator[] = [
  'is',
  'is_not',
  'contains',
  'not_contains',
  'starts_with',
  'is_empty',
  'is_not_empty',
]
const NUMERIC: readonly Operator[] = [
  'is',
  'is_not',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'is_empty',
  'is_not_empty',
]
const TEMPORAL: readonly Operator[] = [
  'is',
  'is_not',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
  'between',
  'is_empty',
  'is_not_empty',
]
const ENUMERATED: readonly Operator[] = ['is', 'is_not', 'in', 'not_in', 'is_empty', 'is_not_empty']

/** How a value is held, compared and rendered. One row per type, and adding a type
 *  means adding one row here plus its editor. 02-foundation.md section 4. */
export type TypeMeta = {
  /** The cast applied to a jsonb value so it sorts and compares as itself. Column
   *  storage needs none. The hot index uses the same expression or it is not used. */
  jsonbCast: 'text' | 'numeric' | 'boolean' | 'timestamptz' | 'date' | 'jsonb'
  operators: readonly Operator[]
  /** The editor the record page and the inline cell render. */
  editor:
    | 'text'
    | 'textarea'
    | 'number'
    | 'boolean'
    | 'date'
    | 'datetime'
    | 'select'
    | 'multi_select'
    | 'user'
    | 'relation'
    | 'json'
  /** Right-aligned in tables and summed on a board footer. */
  numeric?: true
  /** Rendered as a link, never as plain text. */
  link?: 'mailto' | 'tel' | 'href'
  /** Never editable by hand: the system owns the value. */
  readOnly?: true
}

export const TYPE_META: Record<FieldType, TypeMeta> = {
  text: { jsonbCast: 'text', operators: TEXTUAL, editor: 'text' },
  long_text: { jsonbCast: 'text', operators: TEXTUAL, editor: 'textarea' },
  number: { jsonbCast: 'numeric', operators: NUMERIC, editor: 'number', numeric: true },
  currency: { jsonbCast: 'numeric', operators: NUMERIC, editor: 'number', numeric: true },
  percent: { jsonbCast: 'numeric', operators: NUMERIC, editor: 'number', numeric: true },
  boolean: {
    jsonbCast: 'boolean',
    operators: ['is', 'is_empty', 'is_not_empty'],
    editor: 'boolean',
  },
  date: { jsonbCast: 'date', operators: TEMPORAL, editor: 'date' },
  datetime: { jsonbCast: 'timestamptz', operators: TEMPORAL, editor: 'datetime' },
  select: { jsonbCast: 'text', operators: ENUMERATED, editor: 'select' },
  multi_select: {
    jsonbCast: 'jsonb',
    operators: ['in', 'not_in', 'is_empty', 'is_not_empty'],
    editor: 'multi_select',
  },
  email: { jsonbCast: 'text', operators: TEXTUAL, editor: 'text', link: 'mailto' },
  phone: { jsonbCast: 'text', operators: TEXTUAL, editor: 'text', link: 'tel' },
  url: { jsonbCast: 'text', operators: TEXTUAL, editor: 'text', link: 'href' },
  linkedin: { jsonbCast: 'text', operators: TEXTUAL, editor: 'text', link: 'href' },
  address: { jsonbCast: 'text', operators: TEXTUAL, editor: 'textarea' },
  user: { jsonbCast: 'text', operators: ENUMERATED, editor: 'user' },
  relation: { jsonbCast: 'text', operators: ENUMERATED, editor: 'relation' },
  rating: { jsonbCast: 'numeric', operators: NUMERIC, editor: 'number', numeric: true },
  json: { jsonbCast: 'jsonb', operators: ['is_empty', 'is_not_empty'], editor: 'json', readOnly: true },
}

export const operatorsFor = (type: FieldType): readonly Operator[] => TYPE_META[type].operators

/** Longest value any text-shaped field accepts. A 40,000-character CSV cell is
 *  truncated to this with a warning rather than failing the whole import. */
export const MAX_TEXT_LENGTH: Partial<Record<FieldType, number>> = {
  text: 500,
  email: 320,
  phone: 64,
  url: 2048,
  linkedin: 2048,
  address: 1000,
  select: 200,
  long_text: 65_536,
}
