import { groupsComplete } from '~/components/crm/filter-rules.ts'
import type { StepView } from './automation-list.tsx'

/** Every check, branch and set-field action in the rule, however deep, has its values.
 *  The editor keeps an unfinished row so the person can see it, and Save waits for it. */
export const stepsComplete = (steps: StepView[]): boolean =>
  steps.every((step) => {
    if (step.kind === 'guard') return groupsComplete(step.conditions)
    if (step.kind === 'branch') {
      return groupsComplete(step.conditions) && stepsComplete(step.matched) && stepsComplete(step.otherwise)
    }
    if (step.kind === 'action') return step.type !== 'set_field' || Boolean(step.config.field)
    return true
  })
