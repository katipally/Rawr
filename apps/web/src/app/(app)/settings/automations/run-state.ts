import type { BadgeTone } from '@rawr/ui'
import type { AutomationRunState } from '@rawr/db/enums'

/** Typed over the state union, so a state the engine gains is a compile error here
 *  and not a badge with no colour. */
export const STATE_TONE: Record<AutomationRunState, BadgeTone> = {
  waiting: 'accent',
  done: 'ok',
  skipped: 'neutral',
  failed: 'error',
}
