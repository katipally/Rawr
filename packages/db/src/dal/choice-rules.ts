/** Rules that name a select option by its text: filters, conditions, set-field
 *  actions and form visibility. A rename moves the stored values, and these rules
 *  move with them, so a saved view or an automation keeps matching the records it
 *  matched before. Pure: parsed JSON in, new JSON out, nothing read or written. */

export type ChoiceRenames = ReadonlyMap<string, string>

/** Operators that compare a choice by identity. A substring typed by a person
 *  ("contains Ent") is not a reference to one option, so it stays as typed. */
const CHOICE_OPERATORS = new Set(['is', 'is_not', 'in', 'not_in'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One choice or a list of them. Numbers, booleans and nulls are never a choice. */
const renamedValue = (value: unknown, renames: ChoiceRenames): unknown => {
  if (typeof value === 'string') return renames.get(value) ?? value
  if (Array.isArray(value)) return value.map((entry) => renamedValue(entry, renames))
  return value
}

/** Every condition on the property `key`, and every set-field action that writes it,
 *  at any depth: groups, guards, and both arms of a branch. A condition on any other
 *  key is returned as it was. */
export const renameChoicesInRules = (node: unknown, key: string, renames: ChoiceRenames): unknown => {
  if (Array.isArray(node)) return node.map((entry) => renameChoicesInRules(entry, key, renames))
  if (!isRecord(node)) return node

  const next: Record<string, unknown> = {}
  for (const [name, child] of Object.entries(node)) next[name] = renameChoicesInRules(child, key, renames)
  if (next.field === key && CHOICE_OPERATORS.has(String(next.operator)) && 'value' in next) {
    next.value = renamedValue(next.value, renames)
  }
  if (next.type === 'set_field' && isRecord(next.config) && next.config.field === key) {
    next.config = { ...next.config, value: renamedValue(next.config.value, renames) }
  }
  return next
}

/** A form's fields. The choices of a field that maps to `target` (e.g. "contact.stage")
 *  are copies stored on the form, so they are renamed here, and a visibility rule
 *  that names one of those fields is renamed with them. */
export const renameChoicesInFormFields = (fields: unknown[], target: string, renames: ChoiceRenames): unknown[] => {
  const mapped = new Set(fields.flatMap((field) => (isRecord(field) && field.mapsTo === target ? [field.key] : [])))
  return fields.map((field) => {
    if (!isRecord(field)) return field
    const next: Record<string, unknown> = { ...field }
    if (field.mapsTo === target && Array.isArray(field.options)) {
      next.options = field.options.map((option) => {
        if (!isRecord(option) || typeof option.value !== 'string') return option
        const to = renames.get(option.value)
        if (to === undefined) return option
        return { ...option, value: to, label: option.label === option.value ? to : option.label }
      })
    }
    if (isRecord(field.visibleIf) && mapped.has(field.visibleIf.field)) {
      next.visibleIf = { ...field.visibleIf, equals: renamedValue(field.visibleIf.equals, renames) }
    }
    return next
  })
}
