import { requireSummary } from './lookup.ts'

/** Lives outside loading.tsx's Suspense boundary, so a missing booking page is caught
 *  here, before the response starts streaming, and answers 404 rather than 200. */
const BookingPageLayout = async ({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ account: string; slug: string }>
}) => {
  const { account, slug } = await params
  await requireSummary(account, slug)
  return children
}

export default BookingPageLayout
