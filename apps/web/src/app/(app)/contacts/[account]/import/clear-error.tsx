'use client'

import { usePathname } from 'next/navigation'
import { useEffect } from 'react'

/** Takes `?error=` off the address once it has been read.
 *
 *  A failed upload comes back as a redirect carrying its reason in the URL, and
 *  the URL then outlives the message: reloading the page, or coming back to it
 *  after an upload that worked, put the old failure on screen again as though it
 *  had just happened.
 *
 *  `history.replaceState` rather than `router.replace`: the router would ask the
 *  server for this page again, and the answer would no longer have the message
 *  the person is in the middle of reading. This changes the address and nothing
 *  else, so the alert stays until the page is left. */
export const ClearError = () => {
  const pathname = usePathname()
  useEffect(() => {
    if (window.location.search.includes('error=')) window.history.replaceState(null, '', pathname)
  }, [pathname])
  return null
}
