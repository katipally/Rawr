/** How long a toast stays on screen. Pure so the rule is testable without a browser. */

export type ToastTone = 'success' | 'error' | 'info'

export const SHORT_TOAST_MS = 5000
/** Long enough to read the message and reach its button. */
export const ACTION_TOAST_MS = 12000
/** A reader covers roughly 1000 characters a minute, about 60ms each. */
export const READ_MS_PER_CHAR = 60
export const READ_TOAST_MIN_MS = 6000
export const READ_TOAST_MAX_MS = 15000

export const toastLifetime = (input: { tone: ToastTone; message: string; hasAction: boolean }): number => {
  const reading = Math.min(
    READ_TOAST_MAX_MS,
    Math.max(READ_TOAST_MIN_MS, input.message.length * READ_MS_PER_CHAR),
  )
  if (input.hasAction) return Math.max(ACTION_TOAST_MS, reading)
  if (input.tone === 'error') return reading
  return SHORT_TOAST_MS
}
