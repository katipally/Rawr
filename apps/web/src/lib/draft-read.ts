/** The pure half of `useDraft` (drafts.ts): given a raw `localStorage` read and
 *  "now", what it means. Kept in its own module, with no `'use client'`
 *  directive, so it stays importable from a plain unit test -- `useDraft`
 *  itself needs a DOM to exercise at all. */

/** Long enough to survive a busy weekend or a canceled meeting; short enough that
 *  a draft from a task nobody came back to does not reappear weeks later as if it
 *  were still relevant. */
export const DRAFT_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000

export type Stored<T> = { savedAt: number; value: T }

export const draftKey = (account: string, object: string, recordId: string | undefined): string =>
  recordId ? `rawr:draft:${account}:${object}:${recordId}` : `rawr:draft:${account}:${object}`

/** What a raw `localStorage` read resolves to: nothing was ever saved under this
 *  key, what was saved has aged past `DRAFT_EXPIRY_MS`, or a value worth
 *  restoring. */
export type DraftRead<T> = { kind: 'none' } | { kind: 'expired' } | { kind: 'value'; value: T }

export const readDraft = <T,>(raw: string | null, now: number): DraftRead<T> => {
  if (!raw) return { kind: 'none' }
  let parsed: Stored<T>
  try {
    parsed = JSON.parse(raw) as Stored<T>
  } catch {
    return { kind: 'none' }
  }
  if (typeof parsed?.savedAt !== 'number') return { kind: 'none' }
  return now - parsed.savedAt < DRAFT_EXPIRY_MS ? { kind: 'value', value: parsed.value } : { kind: 'expired' }
}
