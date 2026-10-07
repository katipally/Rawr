'use client'

import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { purgeDrafts, SIGNED_OUT_KEY } from './draft-read.ts'

/** Who a draft belongs to. Without a person there is no draft: nothing is saved
 *  or restored, so a form outside the signed-in app can never share one. */
const DraftUser = createContext<string | null>(null)

export const useDraftUser = (): string | null => useContext(DraftUser)

export const DraftScope = ({ userId, children }: { userId: string; children: ReactNode }) => {
  useEffect(() => {
    try {
      purgeDrafts(localStorage, userId)
      localStorage.removeItem(SIGNED_OUT_KEY)
    } catch {
      // Blocked storage holds no drafts to purge.
    }
  }, [userId])
  return <DraftUser value={userId}>{children}</DraftUser>
}
