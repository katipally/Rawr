import { activeForm } from './lookup.ts'

/** Lives outside loading.tsx's Suspense boundary, so a missing form is caught
 *  here, before the response starts streaming, and answers 404 rather than 200. */
const HostedFormLayout = async ({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ path: string[] }>
}) => {
  await activeForm((await params).path)
  return children
}

export default HostedFormLayout
