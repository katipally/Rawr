'use client'

import { usePathname, useRouter } from 'next/navigation'
import {
  createContext,
  startTransition as reactStartTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react'

/** Every in-app navigation goes through one transition, so the shell can show
 *  that something is happening the instant a link is clicked rather than when
 *  the server answers. The clicked destination is known immediately, which is
 *  what lets the rail light up the new tab before the page exists.
 *
 *  Plain left clicks on same-origin links are watched at the document, after
 *  every handler on the way up has had the event, so a Link keeps its own
 *  navigation and an ordinary anchor gets one. Modified clicks, new-tab targets,
 *  downloads, hashes and other origins are left to the browser. */

type Navigation = {
  /** The href a transition is heading for, or null when nothing is pending. */
  pendingHref: string | null
  navigate: (href: string) => void
}

const Context = createContext<Navigation>({ pendingHref: null, navigate: () => {} })

export const useNavigation = () => useContext(Context)

const isPlainLeftClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

export const NavigationProvider = ({ children }: { children: ReactNode }) => {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, startTransition] = useTransition()
  const [target, setTarget] = useState<string | null>(null)
  /** True while the pending navigation is one this provider pushed. A Link's own
   *  push has no transition here to end, and is ended by the address instead. */
  const ours = useRef(false)

  const navigate = useCallback(
    (href: string) => {
      ours.current = true
      // Outside the transition so the rail moves on this very frame.
      setTarget(href)
      startTransition(() => router.push(href))
    },
    [router],
  )

  // Arriving is what ends a navigation, whoever started it, and the address is
  // what the person sees arrive: pathname is a trigger here rather than
  // something the body reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    ours.current = false
    setTarget(null)
  }, [pathname])

  // A push of our own that ends on the address it started from: the same page
  // asked for again, or a route that sent the person back.
  useEffect(() => {
    if (pending || !ours.current) return
    ours.current = false
    reactStartTransition(() => setTarget(null))
  }, [pending])

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!isPlainLeftClick(event)) return
      const anchor = (event.target as Element | null)?.closest('a')
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      if (anchor.dataset.nativeNavigation !== undefined) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      const here = window.location.pathname + window.location.search
      const there = url.pathname + url.search
      if (url.hash && there === here) return
      // The public and API routes are not part of the app router tree.
      if (/^\/(api|b|f|form|c|e|w|t|u|invite|embed\.js|booking\.js)(\/|$)/.test(url.pathname)) return
      if (event.defaultPrevented) {
        // Preventing the browser's own navigation is how a Link takes a click, so
        // by here that navigation is already under way. Nothing to start: only
        // the destination to light up.
        reactStartTransition(() => setTarget(there + url.hash))
        return
      }
      // An ordinary anchor, which React never saw. Its default is a full page
      // load, so this one is ours to take over.
      event.preventDefault()
      navigate(there + url.hash)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [navigate])

  const value = useMemo(() => ({ pendingHref: pending || target ? target : null, navigate }), [pending, target, navigate])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** A 2px bar under the header that fills while a navigation is pending. It is
 *  the only signal a person needs to know their click registered. */
export const NavigationProgress = () => {
  const { pendingHref } = useNavigation()
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
      <div
        className={
          pendingHref
            ? 'h-full w-full origin-left animate-[rawr-progress_1.2s_ease-out_forwards] bg-nav-accent'
            : 'h-full w-0 bg-nav-accent'
        }
      />
    </div>
  )
}
