'use client'

import { useEffect, useRef } from 'react'

/** Long enough to survive a busy weekend or a canceled meeting; short enough that
 *  a draft from a task nobody came back to does not reappear weeks later as if it
 *  were still relevant. */
const DRAFT_EXPIRY_MS = 3 * 24 * 60 * 60 * 1000

type Stored<T> = { savedAt: number; value: T }

const draftKey = (account: string, object: string, recordId: string | undefined): string =>
  recordId ? `rawr:draft:${account}:${object}:${recordId}` : `rawr:draft:${account}:${object}`

/** One create-or-edit form's unsaved input, kept in `localStorage` so it survives
 *  a closed tab or a browser restart, not just the remount create-record.tsx used
 *  to ride out with `sessionStorage`.
 *
 *  `onRestore` is called at most once, on mount, with whatever was saved under
 *  this key and has not expired. It is a callback rather than a merge this hook
 *  does itself because callers disagree on shape: one state object here, several
 *  `useState` fields there. */
export const useDraft = <T,>(
  account: string,
  object: string,
  recordId: string | undefined,
  value: T,
  onRestore: (draft: T) => void,
): { forget: () => void } => {
  const key = draftKey(account, object, recordId)
  const restored = useRef(false)
  const onRestoreRef = useRef(onRestore)
  onRestoreRef.current = onRestore

  useEffect(() => {
    restored.current = false
    try {
      const raw = localStorage.getItem(key)
      const parsed = raw ? (JSON.parse(raw) as Stored<T>) : null
      if (parsed && typeof parsed.savedAt === 'number' && Date.now() - parsed.savedAt < DRAFT_EXPIRY_MS) {
        onRestoreRef.current(parsed.value)
      } else if (parsed) {
        localStorage.removeItem(key)
      }
    } catch {
      // Private window or blocked storage: the form still works, just with no draft.
    }
    restored.current = true
  }, [key])

  useEffect(() => {
    if (!restored.current) return
    try {
      localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }))
    } catch {
      // Quota exceeded or blocked: the form keeps working without a saved draft.
    }
  }, [key, value])

  const forget = () => {
    try {
      localStorage.removeItem(key)
    } catch {
      // Nothing was stored, so nothing to forget.
    }
  }

  return { forget }
}
