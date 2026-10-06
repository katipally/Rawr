'use client'

import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { safePath } from './links.ts'

/** Panels and dialogs a screen can have open over it. A link out of the screen
 *  must not carry them, or Back would reopen the preview the person just left. */
const OVERLAY_PARAMS = ['preview', 'interaction', 'log', 'task', 'new', 'compose', 'action', 'edit', 'segment', 'member', 'invite', 'automation', 'embed', 'move']

/** The address of the screen on show, as the `from` of a link that leaves it. */
export const useOrigin = (): string => {
  const pathname = usePathname()
  const params = new URLSearchParams(useSearchParams())
  for (const key of OVERLAY_PARAMS) params.delete(key)
  const search = params.toString()
  return search ? `${pathname}?${search}` : pathname
}

const BEFORE_SETTINGS = 'rawr.beforeSettings'

/** Remembers the last screen outside Settings, for the Back at the top of the
 *  Settings rail. Session storage rather than the address, because Settings is
 *  entered from the top bar and from links all over, and none of them knows the
 *  screen it is leaving. */
export const useRememberBeforeSettings = (): void => {
  const origin = useOrigin()
  useEffect(() => {
    if (origin.startsWith('/settings')) return
    try {
      sessionStorage.setItem(BEFORE_SETTINGS, origin)
    } catch {
      // Storage is blocked; Back falls back to Home.
    }
  }, [origin])
}

/** The screen Back leaves Settings for: the one remembered, else `fallback`. */
export const useBeforeSettings = (fallback: string): string => {
  const [href, setHref] = useState(fallback)
  useEffect(() => {
    try {
      setHref(safePath(sessionStorage.getItem(BEFORE_SETTINGS), fallback))
    } catch {
      // Storage is blocked; the fallback stands.
    }
  }, [fallback])
  return href
}
