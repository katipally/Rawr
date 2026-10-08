import { publicBookingPage, type PublicBookingPage } from '@rawr/db'
import { notFound } from 'next/navigation'
import { cache } from 'react'

/** One lookup per request, shared by the layout, the metadata and the page. */
export const summaryFor = cache(
  (account: string, slug: string): Promise<PublicBookingPage | null> =>
    publicBookingPage(account, slug),
)

/** Throws the 404 before anything streams, so the status code is a real 404. */
export const requireSummary = async (account: string, slug: string): Promise<PublicBookingPage> => {
  const summary = await summaryFor(account, slug)
  if (!summary) notFound()
  return summary
}
