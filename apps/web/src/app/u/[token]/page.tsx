import { enrollmentAccountForToken, publicEdgeContext, unsubscribeTarget, withAccount } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import { unsubscribeAction } from './actions.ts'

/** The page an unsubscribe link opens.
 *
 *  Deliberately a page with a button rather than an opt-out on GET: mail clients
 *  and scanners prefetch links, and a GET that unsubscribes means a security
 *  appliance can quietly opt somebody out of mail they wanted. Gmail's own
 *  one-click header does POST, which the route handler beside this answers. */
const UnsubscribePage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>
  searchParams: Promise<{ done?: string }>
}) => {
  const { token } = await params
  const { done } = await searchParams

  const accountId = await enrollmentAccountForToken(token)
  const target = accountId
    ? await withAccount({ ...publicEdgeContext(accountId), actorKind: 'public' }, (tx) =>
        unsubscribeTarget(tx, token),
      )
    : null

  if (!target) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center p-6">
        <EmptyState
          title="That link is not one we know"
          description="It may have been from an old mail. Nothing has changed, and you can reply to the sender to be taken off their list."
        />
      </main>
    )
  }

  if (done === '1') {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center p-6">
        <div className="rounded-panel border border-line bg-surface p-4">
          <h1 className="text-base font-medium">You are unsubscribed</h1>
          <p className="mt-1 text-secondary">
            {target.contactEmail} will not receive any more of this. Anything already scheduled has
            been stopped.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center p-6">
      <div className="rounded-panel border border-line bg-surface p-4">
        <h1 className="text-base font-medium">Stop receiving these emails?</h1>
        <p className="mt-1 text-secondary">
          This stops <strong className="text-body">{target.sequenceName}</strong> and anything else of
          the same kind to {target.contactEmail}. You can still reply to the sender directly.
        </p>
        <form action={unsubscribeAction} className="mt-4">
          <input type="hidden" name="token" value={token} />
          <button
            type="submit"
            className="inline-flex min-h-9 items-center rounded-hs bg-cta px-3 font-medium text-white hover:bg-cta-hover"
          >
            Unsubscribe
          </button>
        </form>
      </div>
    </main>
  )
}

export default UnsubscribePage
