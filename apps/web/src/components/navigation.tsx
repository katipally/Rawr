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
 *  Plain left clicks on same-origin links are intercepted at the document, so
 *  every Link in the app takes part without being wrapped. Modified clicks,
 *  new-tab targets, downloads, hashes and other origins are left to the
 *  browser. */

type Navigation = {
  /** The href a transition is heading for, or null when nothing is pending. */
  pendingHref: string | null
  navigate: (href: string) => void
}

const Context = createContext<Navigation>({ pendingHref: null, navigate: () => {} })

export const useNavigation = () => useContext(Context)

const isPlainLeftClick = (event: MouseEvent) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.defaultPrevented

export const NavigationProvider = ({ children }: { children: ReactNode }) => {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, startTransition] = useTransition()
  const [target, setTarget] = useState<string | null>(null)
  const targetRef = useRef<string | null>(null)

  const navigate = useCallback(
    (href: string) => {
      targetRef.current = href
      // Outside the transition so the rail moves on this very frame.
      setTarget(href)
      startTransition(() => router.push(href))
    },
    [router],
  )

  // The transition ends when the new route commits. The address is what the
  // person sees, so it is what clears the target, not the pending flag alone:
  // pathname is a trigger here rather than something the body reads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!pending && targetRef.current !== null) {
      targetRef.current = null
      reactStartTransition(() => setTarget(null))
    }
  }, [pending, pathname])

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
      event.preventDefault()
      // Stop Next's own Link handler from pushing a second time.
      event.stopPropagation()
      navigate(there + url.hash)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
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
