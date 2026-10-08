import type { FilterField, Group } from '~/components/crm/filter-builder.tsx'
import { pruneGroups } from '~/components/crm/filter-rules.ts'
import type { StepView } from './automation-list.tsx'

/** What one object gives a rule: the fields its conditions can test, the fields a
 *  set-field action can write, and the dates a date trigger can wait for. */
export type ObjectScope = {
  filterFields: FilterField[]
  settable: string[]
  dates: { key: string; label: string }[]
}

/** Keeps only what the new object has. Conditions on a field it lacks are dropped
 *  from the rule, and so are a set-field action's field and a date trigger's date
 *  when the new object lacks them, cleared to empty so the editor asks for a pick.
 *  `removed` names each one dropped, by the label it had on the old object. */
export const scopeRule = (
  rule: { conditions: Group[]; steps: StepView[]; triggerConfig: Record<string, string> },
  next: ObjectScope,
  previous: ObjectScope,
): { conditions: Group[]; steps: StepView[]; triggerConfig: Record<string, string>; removed: string[] } => {
  const keys = new Set(next.filterFields.map((field) => field.key))
  const labels = new Map(previous.filterFields.map((field) => [field.key, field.label]))
  const settable = new Set(next.settable)
  const removed: string[] = []
  const prune = (groups: Group[]): Group[] => {
    const pruned = pruneGroups(groups, keys, labels)
    removed.push(...pruned.removed)
    return pruned.groups
  }
  const walk = (steps: StepView[]): StepView[] =>
    steps.map((step) => {
      if (step.kind === 'action' && step.type === 'set_field' && step.config.field && !settable.has(step.config.field)) {
        removed.push(labels.get(step.config.field) ?? step.config.field)
        return { ...step, config: { ...step.config, field: '' } }
      }
      if (step.kind === 'guard') return { ...step, conditions: prune(step.conditions) }
      if (step.kind === 'branch') {
        return { ...step, conditions: prune(step.conditions), matched: walk(step.matched), otherwise: walk(step.otherwise) }
      }
      return step
    })

  const conditions = prune(rule.conditions)
  const steps = walk(rule.steps)
  const triggerConfig = { ...rule.triggerConfig }
  const fieldKey = rule.triggerConfig.fieldKey
  if (fieldKey && !next.dates.some((date) => date.key === fieldKey)) {
    removed.push(previous.dates.find((date) => date.key === fieldKey)?.label ?? fieldKey)
    triggerConfig.fieldKey = ''
  }
  return { conditions, steps, triggerConfig, removed }
}
