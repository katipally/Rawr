import type { SendWindow } from '@rawr/db'

export type SendingInput = { cap: number; gap: number; hours: SendWindow | null }

/** What is wrong with a sending limit, one sentence per failing part. Empty when it can be saved. */
export const sendingProblems = ({ cap, gap, hours }: SendingInput): string[] => {
  const problems: string[] = []
  if (!Number.isInteger(cap) || cap < 1 || cap > 2000) problems.push('Most a day is 1 to 2000.')
  if (!Number.isInteger(gap) || gap < 0 || gap > 86400) problems.push('Seconds between sends is 0 to 86400.')
  if (hours && (hours.days.length === 0 || !hours.start || !hours.end || hours.start >= hours.end)) {
    problems.push('Hours need at least one day and an end after the start.')
  }
  return problems
}

export type ReadOutcome = { read: number; stored: number; alreadyHad: number; skipped: number; reason: string | null }

/** What a read reports. The refused sentence states the fixed rules, because the sync keeps counts, not a reason per message. */
export const readNotice = (outcome: ReadOutcome): string => {
  const counts = `${outcome.read} read: ${outcome.stored} new, ${outcome.alreadyHad} already had, ${outcome.skipped} refused.`
  const rules = outcome.skipped > 0 ? ' Refused mail is internal, personal or excluded by hand, so it is never stored.' : ''
  return `${counts}${rules}${outcome.reason ? ` ${outcome.reason}` : ''}`
}
