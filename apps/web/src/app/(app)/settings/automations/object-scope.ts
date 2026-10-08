import type { FilterField, Group } from '~/components/crm/filter-builder.tsx'
import { pruneGroups } from '~/components/crm/filter-rules.ts'
import type { ActionType, StepView } from './automation-list.tsx'

/** Every action a rule can take, with the words the dropdown shows for it. */
export const ACTIONS: { key: ActionType; label: string }[] = [
  { key: 'set_field', label: 'Set a field' },
  { key: 'set_lifecycle', label: 'Move the lifecycle stage' },
  { key: 'assign_owner', label: 'Assign an owner' },
  { key: 'create_task', label: 'Create a task' },
  { key: 'notify_slack', label: 'Post to Slack' },
  { key: 'send_email', label: 'Send an email' },
  { key: 'enroll_in_sequence', label: 'Enroll in a sequence' },
  { key: 'webhook', label: 'Call a webhook' },
]

/** The two that write to a person. A rule watching a company or a deal cannot
 *  offer them: only a contact has an inbox. */
export const CONTACT_ONLY: ActionType[] = ['send_email', 'enroll_in_sequence']

/** What one object gives a rule: the fields its conditions can test, the fields a
 *  set-field action can write, the dates a date trigger can wait for, and whether
 *  it has an inbox for the actions in CONTACT_ONLY. */
export type ObjectScope = {
  filterFields: FilterField[]
  settable: string[]
  dates: { key: string; label: string }[]
  hasInbox: boolean
}

/** Keeps only what the new object has. Conditions on a field it lacks are dropped
 *  from the rule, and so are a set-field action's field and a date trigger's date
 *  when the new object lacks them, cleared to empty so the editor asks for a pick.
 *  A contact-only action is dropped whole when the new object has no inbox.
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
    steps.flatMap((step): StepView[] => {
      if (step.kind === 'action' && CONTACT_ONLY.includes(step.type) && !next.hasInbox) {
        removed.push(ACTIONS.find((entry) => entry.key === step.type)?.label ?? step.type)
        return []
      }
      if (step.kind === 'action' && step.type === 'set_field' && step.config.field && !settable.has(step.config.field)) {
        removed.push(labels.get(step.config.field) ?? step.config.field)
        return [{ ...step, config: { ...step.config, field: '' } }]
      }
      if (step.kind === 'guard') return [{ ...step, conditions: prune(step.conditions) }]
      if (step.kind === 'branch') {
        return [{ ...step, conditions: prune(step.conditions), matched: walk(step.matched), otherwise: walk(step.otherwise) }]
      }
      return [step]
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
