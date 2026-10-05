import { cache } from 'react'
import { headers } from 'next/headers'
import { FALLBACK, createFormat, localeFrom } from '~/lib/format.ts'
import { readSession } from './session.ts'

/** The formatter for the request being rendered: the viewer's locale from the
 *  browser, their zone and the account's currency from the session. The layout
 *  hands the same three to the client components (`FormatProvider`), which is
 *  what makes a number written here the same string once it is hydrated.
 *
 *  Deduplicated per request like `readSession`, which it rests on. */
export const getFormat = cache(async () => {
  const [session, requested] = await Promise.all([readSession(), headers()])
  return createFormat({
    locale: localeFrom(requested.get('accept-language')),
    zone: session?.timezone ?? FALLBACK.zone,
    currency: session?.accountCurrency ?? FALLBACK.currency,
  })
})
