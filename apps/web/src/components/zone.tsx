'use client'

import { useEffect, createContext, useContext, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '~/lib/rpc.ts'

/** The zone every timestamp on screen is written in, for the components that
 *  cannot read the session.
 *
 *  A server component awaits `readSession()` and passes the zone down. A client
 *  component is rendered on the server too, so it cannot read a cookie and cannot
 *  guess from the browser either: guessing is what put the container's clock in
 *  the markup and the reader's clock in the hydrated page, which React reports as
 *  a failure and repairs by throwing the server's work away. One value, sent from
 *  the layout, is what makes both sides agree. */
const ZoneContext = createContext('UTC')

export const ZoneProvider = ({ zone, children }: { zone: string; children: ReactNode }) => (
  <ZoneContext value={zone}>{children}</ZoneContext>
)

export const useZone = (): string => useContext(ZoneContext)

/** Nobody has said which zone they are in, so the browser is asked once and the
 *  answer is stored. UTC until then, which is honest rather than a guess dressed
 *  up as a preference, and only wrong for the first paint of a first visit.
 *
 *  Mounted by the shell rather than run on the server, because the browser is the
 *  only place the answer exists. */
export const AdoptZone = ({ stored }: { stored: string }) => {
  const router = useRouter()

  useEffect(() => {
    if (stored !== 'UTC') return
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (!here || here === 'UTC') return
    api.booking.adoptTimezone
      .mutate({ timezone: here })
      // A seat without availability access cannot write one, and a person who
      // reads timestamps in UTC for it is a smaller problem than an error toast
      // on every page they open.
      .then((adopted) => adopted && router.refresh())
      .catch(() => {})
  }, [stored, router])

  return null
}
