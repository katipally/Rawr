import {
  describeAmbiguity,
  resolveRecord,
  type Registry,
  type RegistryObject,
  type AccountContext,
} from '@rawr/db'
import type { Lookups } from '~/server/crm.ts'
import { resolveDate } from './dates.ts'

/** F5 §4. What an agent says, turned into what the registry accepts, or refused.
 *
 *  The screens hand the data access layer an id because a picker put one there. An
 *  agent hands it "Closed Won", "Trevor", "October 15th". Those are three different
 *  lookups and all three can be ambiguous, so each one either resolves to exactly
 *  one value or comes back as a sentence naming the choices. Nothing is guessed.
 *
 *  Coercion itself is not repeated here. Once a value is an id, a number or an ISO
 *  date, it goes through the same `coerce` in the data access layer that every
 *  other write does, so an agent cannot reach a shape a person could not. */

export type Prepared = {
  values: Record<string, unknown>
  /** One line per value that was interpreted rather than taken literally, quoted
   *  back in the response. §4: the assistant states what was actually set. */
  notes: string[]
}

export class FieldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FieldError'
  }
}

/** Enough that no real request is refused, low enough that a loop is. §Edge cases,
 *  "an agent sends 500 fields". */
const MAX_FIELDS = 60

export const prepareFields = async (
  ctx: AccountContext,
  object: RegistryObject,
  lookups: Lookups,
  input: Record<string, unknown>,
  today: string,
): Promise<Prepared> => {
  const keys = Object.keys(input)
  if (keys.length === 0) throw new FieldError('No fields were given, so there is nothing to change.')
  if (keys.length > MAX_FIELDS) {
    throw new FieldError(`That is ${keys.length} fields in one call; ${MAX_FIELDS} is the limit.`)
  }

  const unknown = keys.filter((key) => !object.byKey.has(key))
  if (unknown.length > 0) {
    // The valid list comes back with the refusal so the next attempt succeeds,
    // rather than making the agent guess a second time. §Edge cases.
    throw new FieldError(
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} on ${object.nameSingular.toLowerCase()}. Valid keys: ${object.fields.map((f) => f.key).join(', ')}.`,
    )
  }

  const values: Record<string, unknown> = {}
  const notes: string[] = []

  for (const key of keys) {
    const field = object.byKey.get(key)!
    const raw = input[key]

    if (raw === null || raw === '') {
      values[key] = null
      continue
    }

    switch (field.type) {
      case 'date':
      case 'datetime': {
        if (typeof raw !== 'string') {
          throw new FieldError(`${field.label} needs a date, and this was a ${typeof raw}.`)
        }
        const resolved = resolveDate(raw, today)
        if (!resolved.ok) throw new FieldError(`${field.label}: ${resolved.reason}`)
        values[key] = resolved.day
        if (resolved.how !== 'as given') notes.push(`${field.label} set to ${resolved.day} (${raw} read as ${resolved.how}).`)
        else notes.push(`${field.label} set to ${resolved.day}.`)
        break
      }

      case 'select':
      case 'multi_select': {
        const wanted = Array.isArray(raw) ? raw.map(String) : [String(raw)]
        const picked = wanted.map((one) => matchOption(field.label, field.options, one))
        values[key] = field.type === 'multi_select' ? picked : picked[0]
        break
      }

      case 'user': {
        const match = matchChoice(lookups.users, String(raw))
        if (match.kind !== 'one') {
          throw new FieldError(choiceRefusal(field.label, String(raw), match, lookups.users))
        }
        values[key] = match.choice.id
        notes.push(`${field.label} set to ${match.choice.label}.`)
        break
      }

      case 'relation': {
        const resolved = await relationValue(ctx, key, lookups, String(raw))
        values[key] = resolved.id
        notes.push(`${field.label} set to ${resolved.label}.`)
        break
      }

      default:
        values[key] = raw
    }
  }

  return { values, notes }
}

const matchOption = (label: string, options: string[], wanted: string): string => {
  const found = options.find((option) => option.toLowerCase() === wanted.trim().toLowerCase())
  if (found) return found
  throw new FieldError(
    `"${wanted}" is not one of ${label}'s choices. Valid values: ${options.join(', ')}.`,
  )
}

type ChoiceMatch =
  | { kind: 'one'; choice: { id: string; label: string } }
  | { kind: 'many'; choices: { id: string; label: string }[] }
  | { kind: 'none' }

/** Exact label, then exact id, then a unique prefix or substring. Deliberately not
 *  fuzzy: a list of twelve stage names is small enough that a near miss is more
 *  likely to be a different stage than a typo. */
const matchChoice = (choices: { id: string; label: string }[], wanted: string): ChoiceMatch => {
  const needle = wanted.trim().toLowerCase()
  const exact = choices.filter((choice) => choice.label.toLowerCase() === needle)
  if (exact.length === 1) return { kind: 'one', choice: exact[0]! }
  if (exact.length > 1) return { kind: 'many', choices: exact }

  const byId = choices.find((choice) => choice.id === wanted)
  if (byId) return { kind: 'one', choice: byId }

  const partial = choices.filter((choice) => choice.label.toLowerCase().includes(needle))
  if (partial.length === 1) return { kind: 'one', choice: partial[0]! }
  if (partial.length > 1) return { kind: 'many', choices: partial }
  return { kind: 'none' }
}

const choiceRefusal = (
  label: string,
  wanted: string,
  match: ChoiceMatch,
  all: { id: string; label: string }[],
): string => {
  if (match.kind === 'many') {
    return `"${wanted}" matches more than one ${label}: ${match.choices.map((c) => c.label).join(', ')}. Nothing was changed. Say which one.`
  }
  return `"${wanted}" is not a ${label} here. Valid values: ${all.map((c) => c.label).join(', ')}.`
}

/** The five relation fields the registry declares. Four are short fixed lists and
 *  resolve by name; a company is a record like any other and goes through the same
 *  resolver as a deal reference, ambiguity and all. */
const relationValue = async (
  ctx: AccountContext,
  key: string,
  lookups: Lookups,
  wanted: string,
): Promise<{ id: string; label: string }> => {
  const list =
    key === 'stage_id'
      ? lookups.stages.map((stage) => ({ id: stage.id, label: stage.label }))
      : key === 'pipeline_id'
        ? lookups.pipelines
        : key === 'lifecycle_stage_id'
          ? lookups.lifecycleStages
          : key === 'owner_id'
            ? lookups.users
            : null

  if (list) {
    const match = matchChoice(list, wanted)
    if (match.kind !== 'one') throw new FieldError(choiceRefusal(key.replace(/_id$/, ''), wanted, match, list))
    return match.choice
  }

  if (key === 'company_id') {
    const resolution = await resolveRecord(ctx, 'company', wanted)
    if (resolution.kind === 'one') {
      return { id: resolution.record.id, label: resolution.record.displayName }
    }
    throw new FieldError(
      describeAmbiguity(
        { singular: 'company', plural: 'companies' },
        wanted,
        resolution.kind === 'many' ? resolution.candidates : resolution.suggestions,
      ),
    )
  }

  throw new FieldError(`${key} points at a record, and this build cannot look one up by name yet. Give the id.`)
}

/** Shared by every tool that takes an `object` argument, so "Deals" and "deal" and
 *  "deals" all mean the same thing and a typo names the valid set.
 *
 *  Matched against the registry rather than a fixed list of three, so an object an
 *  admin invented is reachable by its key, its singular name or its plural the day
 *  it exists, with no tool definition to change. */
export const objectFromArg = (registry: Registry, value: unknown): RegistryObject => {
  const wanted = String(value ?? '').trim().toLowerCase()
  const match = registry.objects.find(
    (object) =>
      object.key === wanted ||
      object.nameSingular.toLowerCase() === wanted ||
      object.namePlural.toLowerCase() === wanted ||
      // "deals" against the key, which is how a model most often writes it.
      object.key === wanted.replace(/s$/, ''),
  )
  if (!match) {
    const valid = registry.objects.map((object) => object.key).join(', ')
    throw new FieldError(`"${String(value)}" is not an object here. Valid objects: ${valid}.`)
  }
  return match
}
