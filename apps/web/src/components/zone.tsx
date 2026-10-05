'use client'

import { useEffect, useMemo, createContext, useContext, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { FALLBACK, createFormat, type Format, type FormatSettings } from '~/lib/format.ts'
import { api } from '~/lib/rpc.ts'

/** How every date, number and amount on screen is written, for the components that
 *  cannot read the session.
 *
 *  A server component awaits `getFormat()`. A client component is rendered on the
 *  server too, so it cannot read a cookie and cannot guess from the browser
 *  either: guessing is what put the container's locale and clock in the markup and
 *  the reader's in the hydrated page, which React reports as a failure and repairs
 *  by throwing the server's work away. One value, sent from the layout, is what
 *  makes both sides agree. */
const FormatContext = createContext<Format>(createFormat(FALLBACK))

export const FormatProvider = ({ locale, zone, currency, children }: FormatSettings & { children: ReactNode }) => {
  const format = useMemo(() => createFormat({ locale, zone, currency }), [locale, zone, currency])
  return <FormatContext value={format}>{children}</FormatContext>
}

/** A part of the app that reads its times in another zone than the person's (the
 *  reports, in the account's), with the locale and currency left as they were. */
export const ZoneProvider = ({ zone, children }: { zone: string; children: ReactNode }) => {
  const { locale, currency } = useContext(FormatContext)
  return (
    <FormatProvider locale={locale} zone={zone} currency={currency}>
      {children}
    </FormatProvider>
  )
}

export const useFormat = (): Format => useContext(FormatContext)

export const useZone = (): string => useContext(FormatContext).zone

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
