'use client'

import { usePathname, useSearchParams } from 'next/navigation'

/** Panels and dialogs a screen can have open over it. A link out of the screen
 *  must not carry them, or Back would reopen the preview the person just left. */
const OVERLAY_PARAMS = ['preview', 'log', 'task', 'new', 'compose']

/** The address of the screen on show, as the `from` of a link that leaves it. */
export const useOrigin = (): string => {
  const pathname = usePathname()
  const params = new URLSearchParams(useSearchParams())
  for (const key of OVERLAY_PARAMS) params.delete(key)
  const search = params.toString()
  return search ? `${pathname}?${search}` : pathname
}
