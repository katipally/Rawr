'use client'

import { useEffect, useRef, useState } from 'react'
import { draftKey, purgeDrafts, readDraft, SIGNED_OUT_KEY } from './draft-read.ts'
import { useDraftUser } from './draft-scope.tsx'

/** One create-or-edit form's unsaved input, kept in `localStorage` so it survives
 *  a closed tab or a browser restart, not just the remount create-record.tsx used
 *  to ride out with `sessionStorage`.
 *
 *  `onRestore` is called at most once, on mount, with whatever was saved under
 *  this key and has not expired. It is a callback rather than a merge this hook
 *  does itself because callers disagree on shape: one state object here, several
 *  `useState` fields there.
 *
 *  The restore and the autosave race by nature: the autosave effect sees this
 *  render's `value` before a restore dispatched from the other effect has been
 *  applied. `restoredKey` closes that gap -- it is state, not a ref, so the
 *  render where it first equals `key` is guaranteed to be the render after
 *  restore's own state updates landed, batched together with it. Until then the
 *  save effect does not run at all. */
export const useDraft = <T,>(
  account: string,
  object: string,
  recordId: string | undefined,
  value: T,
  onRestore: (draft: T) => void,
): { forget: () => void } => {
  const userId = useDraftUser()
  const key = userId ? draftKey(userId, account, object, recordId) : null
  const [restoredKey, setRestoredKey] = useState<string | null>(null)
  const onRestoreRef = useRef(onRestore)
  onRestoreRef.current = onRestore
  // True from the first render where `restoredKey` matches `key` onward, so that
  // first render's write (redundant: it is either the value we just restored, or
  // a pristine default that never should have been treated as a saved draft) can
  // be skipped without also skipping every real edit after it.
  const settled = useRef(false)

  useEffect(() => {
    if (!key) return
    settled.current = false
    try {
      const read = readDraft<T>(localStorage.getItem(key), Date.now())
      if (read.kind === 'value') onRestoreRef.current(read.value)
      else if (read.kind === 'expired') localStorage.removeItem(key)
    } catch {
      // Private window or blocked storage: the form still works, just with no draft.
    }
    setRestoredKey(key)
  }, [key])

  useEffect(() => {
    if (!key || restoredKey !== key) return
    if (!settled.current) {
      settled.current = true
      return
    }
    try {
      if (localStorage.getItem(SIGNED_OUT_KEY)) return
      localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value }))
    } catch {
      // Quota exceeded or blocked: the form keeps working without a saved draft.
    }
  }, [key, value, restoredKey])

  const forget = () => {
    if (!key) return
    try {
      localStorage.removeItem(key)
    } catch {
      // Nothing was stored, so nothing to forget.
    }
  }

  return { forget }
}

/** Signing out takes the person's unsent text off this machine, and tells any other
 *  tab still open on the session to stop saving more. */
export const forgetDrafts = (): void => {
  try {
    purgeDrafts(localStorage)
    localStorage.setItem(SIGNED_OUT_KEY, String(Date.now()))
  } catch {
    // Blocked storage holds no drafts to forget.
  }
}
