'use client'

import { startTransition, useEffect, useState } from 'react'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { api } from '~/lib/rpc.ts'

/** Everything this browser remembers about how somebody uses the app.
 *
 *  One store and one key, rather than a `localStorage` call in each component
 *  that wanted to remember something. The point is not tidiness: a component that
 *  reads storage in an effect only knows what it wrote itself, so two screens
 *  showing the same preference disagreed until one of them was reloaded. Here a
 *  change reaches every subscriber in the same render.
 *
 *  Everything below except `railExpanded` used to live only in this browser's
 *  localStorage: it did not follow a person to another machine, and it leaked
 *  between accounts on a shared browser. `usePreferencesSync` (bottom of this
 *  file) hydrates the four fields below from the server on mount and pushes
 *  changes back, debounced. `railExpanded` alone stays local as well, purely so
 *  the very first paint has the right rail width before the server answers. */

export type Bookmark = { href: string; label: string }
export type RecentItem = { href: string; label: string }

/** Past this a list is a rail with extra steps. */
const MAX_RECENT = 5

/** How long to wait after the last change to a synced field before writing it,
 *  so toggling a bookmark or dragging through timeline filters is one request,
 *  not one per click. */
const SYNC_DEBOUNCE_MS = 800

/** The fields backed by the server, and the preference key each is stored under.
 *  `panelOpen` is one key holding a map rather than one key per card, because the
 *  set of collapsible panels is unbounded (an admin's custom object gets one) and
 *  a key per card would be a preference row nobody ever prunes. */
const SYNCED_KEYS = {
  railExpanded: 'railExpanded',
  bookmarks: 'bookmarks',
  recent: 'recent',
  timelineKinds: 'timelineKinds',
  panelOpen: 'panelOpen',
} as const
type SyncedField = keyof typeof SYNCED_KEYS

type UiState = {
  railExpanded: boolean
  bookmarks: Bookmark[]
  /** Where somebody went from the command palette, most recent first. */
  recent: RecentItem[]
  /** Which activity kinds a record's timeline is filtered to, by object key. An
   *  object with no entry shows everything, which is what an empty filter means. */
  timelineKinds: Record<string, string[]>
  /** Whether a collapsible panel is open, by a caller-chosen key (for example
   *  `assoc:deal` on a record page's association rail). A panel with no entry
   *  defaults open, the way it always has. */
  panelOpen: Record<string, boolean>

  setRailExpanded: (expanded: boolean) => void
  toggleBookmark: (entry: Bookmark) => void
  removeBookmark: (href: string) => void
  remember: (item: RecentItem) => void
  setTimelineKinds: (object: string, kinds: string[]) => void
  setPanelOpen: (key: string, open: boolean) => void
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      railExpanded: false,
      bookmarks: [],
      recent: [],
      timelineKinds: {},
      panelOpen: {},

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
      setPanelOpen: (key, open) => set((state) => ({ panelOpen: { ...state.panelOpen, [key]: open } })),
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
      // Only the rail is saved locally going forward; the rest is server-backed.
      // This also carries the one-time migration: the first successful sync
      // below calls `set`, which rewrites this key through this same partialize
      // and so drops whatever bookmarks/recent/timelineKinds/panelOpen an older
      // build had left in it, without a separate delete step.
      partialize: (state) => ({ railExpanded: state.railExpanded }),
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

const isBookmarkArray = (value: unknown): value is Bookmark[] =>
  Array.isArray(value) && value.every((row) => row && typeof row === 'object' && typeof (row as Bookmark).href === 'string')

const isRecentArray = (value: unknown): value is RecentItem[] =>
  Array.isArray(value) && value.every((row) => row && typeof row === 'object' && typeof (row as RecentItem).href === 'string')

const isStringArrayRecord = (value: unknown): value is Record<string, string[]> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every((row) => Array.isArray(row))

const isBooleanRecord = (value: unknown): value is Record<string, boolean> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every((row) => typeof row === 'boolean')

let syncStarted = false
const writeTimers: Partial<Record<SyncedField, ReturnType<typeof setTimeout>>> = {}

const scheduleWrite = (field: SyncedField, value: unknown) => {
  const timer = writeTimers[field]
  if (timer) clearTimeout(timer)
  writeTimers[field] = setTimeout(() => {
    api.preferences.set.mutate({ key: SYNCED_KEYS[field], value }).catch(() => {
      // Offline or blocked: the value stays right locally (it is already in the
      // store) and goes out again on the next change to this field, or the next
      // full page load's hydrate-and-migrate pass.
    })
  }, SYNC_DEBOUNCE_MS)
}

/** Debounced write-back, started only once the initial hydrate below has run:
 *  writing before then could race a slow `all` fetch and re-send a value the
 *  server was about to overwrite anyway. */
const startWriteBack = () => {
  if (syncStarted) return
  syncStarted = true
  let previous = useUi.getState()
  useUi.subscribe((state) => {
    for (const field of Object.keys(SYNCED_KEYS) as SyncedField[]) {
      if (state[field] !== previous[field]) scheduleWrite(field, state[field])
    }
    previous = state
  })
}

/** Called once, from the app shell every signed-in page renders. Migrates
 *  whatever this browser already had in `rawr.ui` to the server, then hydrates
 *  the store from there, then arms the debounced write-back above.
 *
 *  Idempotent by construction rather than by a "did this run" flag: the push
 *  below only ever fires for fields that are still non-empty in local storage,
 *  and a successful push is immediately followed by a `set` that (through
 *  `partialize`) rewrites `rawr.ui` down to just `railExpanded` — so a second
 *  run, on this device or after a reload, finds nothing left to migrate. If the
 *  push fails, nothing is written locally or remotely, and the next mount tries
 *  again with the same local values. */
export const usePreferencesSync = (): void => {
  useEffect(() => {
    let cancelled = false

    // An older build wrote contact emails to this key; nothing else will ever clear it.
    try {
      window.localStorage.removeItem('rawr.recent-search')
    } catch {
      // Private mode or blocked storage: nothing to clean up.
    }

    const run = async () => {
      if (!useUi.persist.hasHydrated()) {
        await new Promise<void>((resolve) => {
          const unsub = useUi.persist.onFinishHydration(() => {
            unsub?.()
            resolve()
          })
        })
      }
      if (cancelled) return

      const local = useUi.getState()
      const legacy: Partial<Record<SyncedField, unknown>> = {}
      if (local.bookmarks.length) legacy.bookmarks = local.bookmarks
      if (local.recent.length) legacy.recent = local.recent
      if (Object.keys(local.timelineKinds).length) legacy.timelineKinds = local.timelineKinds
      if (Object.keys(local.panelOpen).length) legacy.panelOpen = local.panelOpen

      try {
        for (const [field, value] of Object.entries(legacy) as [SyncedField, unknown][]) {
          await api.preferences.set.mutate({ key: SYNCED_KEYS[field], value })
        }
        const server = await api.preferences.all.query()
        if (cancelled) return

        const railExpanded = server.railExpanded
        useUi.setState({
          railExpanded: typeof railExpanded === 'boolean' ? railExpanded : local.railExpanded,
          bookmarks: isBookmarkArray(server.bookmarks) ? server.bookmarks : local.bookmarks,
          recent: isRecentArray(server.recent) ? server.recent : local.recent,
          timelineKinds: isStringArrayRecord(server.timelineKinds) ? server.timelineKinds : local.timelineKinds,
          panelOpen: isBooleanRecord(server.panelOpen) ? server.panelOpen : local.panelOpen,
        })
        startWriteBack()
      } catch {
        // No network, signed out mid-flight, or the server did not answer: keep
        // rendering the local copy and try the same migration and hydrate next
        // time this mounts.
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [])
}
