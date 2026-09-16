'use client'

import { startTransition, useEffect, useState } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/** Everything this browser remembers about how somebody uses the app.
 *
 *  One store and one key, rather than a `localStorage` call in each component
 *  that wanted to remember something. The point is not tidiness: a component that
 *  reads storage in an effect only knows what it wrote itself, so two screens
 *  showing the same preference disagreed until one of them was reloaded. Here a
 *  change reaches every subscriber in the same render.
 *
 *  Nothing here is authoritative. It is preferences and breadcrumbs, and each one
 *  has to read sensibly as its default, because storage can be empty, blocked or
 *  full: a private window, cleared site data, or a browser that refuses to write.
 *  Anything that has to survive being on a different machine belongs in the
 *  database instead. */

export type Bookmark = { href: string; label: string }
export type RecentItem = { href: string; label: string }

/** Past this a list is a rail with extra steps. */
const MAX_RECENT = 5

type UiState = {
  railExpanded: boolean
  bookmarks: Bookmark[]
  /** Where somebody went from the command palette, most recent first. */
  recent: RecentItem[]
  /** Which activity kinds a record's timeline is filtered to, by object key. An
   *  object with no entry shows everything, which is what an empty filter means. */
  timelineKinds: Record<string, string[]>

  setRailExpanded: (expanded: boolean) => void
  toggleBookmark: (entry: Bookmark) => void
  removeBookmark: (href: string) => void
  remember: (item: RecentItem) => void
  setTimelineKinds: (object: string, kinds: string[]) => void
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      railExpanded: false,
      bookmarks: [],
      recent: [],
      timelineKinds: {},

      setRailExpanded: (railExpanded) => set({ railExpanded }),
      toggleBookmark: (entry) =>
        set((state) => ({
          bookmarks: state.bookmarks.some((row) => row.href === entry.href)
            ? state.bookmarks.filter((row) => row.href !== entry.href)
            : [...state.bookmarks, entry],
        })),
      removeBookmark: (href) => set((state) => ({ bookmarks: state.bookmarks.filter((row) => row.href !== href) })),
      remember: (item) =>
        set((state) => ({
          recent: [item, ...state.recent.filter((row) => row.href !== item.href)].slice(0, MAX_RECENT),
        })),
      setTimelineKinds: (object, kinds) =>
        set((state) => ({ timelineKinds: { ...state.timelineKinds, [object]: kinds } })),
    }),
    {
      name: 'rawr.ui',
      // Wrapped, because every one of these throws rather than returning nothing
      // in a private window or with site data blocked, and an app that will not
      // render there is worse than one that forgets a preference.
      storage: createJSONStorage(() => ({
        getItem: (key) => {
          try {
            return window.localStorage.getItem(key)
          } catch {
            return null
          }
        },
        setItem: (key, value) => {
          try {
            window.localStorage.setItem(key, value)
          } catch {
            // The preference holds for this page view and no longer.
          }
        },
        removeItem: (key) => {
          try {
            window.localStorage.removeItem(key)
          } catch {
            // Same.
          }
        },
      })),
    },
  ),
)

/** False until the stored values have replaced the defaults.
 *
 *  The server renders the defaults, because it cannot see this browser's storage.
 *  A component that rendered the stored value on its first client render would
 *  disagree with that markup, and React would throw the whole tree away. So a
 *  component reads this and shows the default for one render, which is the same
 *  shape the app used before the store existed: read it in an effect, render it
 *  on the next pass.
 *
 *  Two details are load-bearing, and both were wrong here before.
 *
 *  It starts false rather than at `hasHydrated()`. `localStorage` is synchronous,
 *  so persist rehydrates while this module is being evaluated and `hasHydrated()`
 *  is already true by the very first client render. Reading it there put the
 *  stored value into the render that has to match the server's markup, which is
 *  the mismatch this hook exists to avoid.
 *
 *  And the flip is a transition. An urgent update from the shell while the page
 *  below it is still streaming makes React give up on the server's half-arrived
 *  Suspense boundary and render it itself, and the boundary then sits on its
 *  loading state for ever. A transition lets React finish the boundary first. */
export const useUiReady = (): boolean => {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (useUi.persist.hasHydrated()) {
      startTransition(() => setReady(true))
      return
    }
    return useUi.persist.onFinishHydration(() => startTransition(() => setReady(true)))
  }, [])
  return ready
}
