import { readInvitationOffer } from '@rawr/db'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Button, EmptyState } from '@rawr/ui'
import { readSession } from '~/server/session.ts'

/** The page an invitation link opens. It says who is inviting whom, and nothing
 *  about anybody else: an invitation link ends up in mail, and mail gets forwarded.
 *
 *  Reading never changes anything: accepting writes a seat and a cookie, which a
 *  route handler may do and a page may not. Somebody signed in as the invited
 *  address is sent to that handler, which accepts and seats them. Somebody signed
 *  out follows a link to the same handler, which parks the token in an httpOnly
 *  cookie and sends them to sign in; the callback redeems it and checks that the
 *  address they signed in with is the one that was invited. */
const InvitePage = async ({ params }: { params: Promise<{ token: string }> }) => {
  const { token } = await params
  const offer = await readInvitationOffer(token)

  if (!offer) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
        <EmptyState
          title="That invitation is no longer good"
          description="It may have been accepted already, revoked, or replaced by a newer one. Ask whoever invited you to send another."
        />
      </main>
    )
  }

  if (offer.expired) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
        <EmptyState
          title="That invitation has expired"
          description={`Invitations to ${offer.accountName} last two weeks. Ask for a new link and it will work straight away.`}
        />
      </main>
    )
  }

  const session = await readSession()
  const acceptPath = `/api/auth/invite/${token}`

  if (session) {
    if (session.email.toLowerCase() === offer.email.toLowerCase()) redirect(acceptPath)
    return (
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
        <EmptyState
          title={`This invitation is for ${offer.email}`}
          description={`You are signed in as ${session.email}. Sign out and sign back in as ${offer.email}, or ask for an invitation to the address you use.`}
          action={
            <form action="/api/auth/sign-out" method="post">
              <Button type="submit" variant="primary">
                Sign out
              </Button>
            </form>
          }
        />
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
      <h1>
        <img src="/rawr-logo.svg" alt="Rawr" width={143} height={60} className="h-9 w-auto" />
      </h1>
      <div className="rounded-panel border border-line bg-surface p-4">
        <h2 className="text-base font-medium">You have been invited to {offer.accountName}</h2>
        <p className="mt-1 text-secondary">
          The invitation is for <strong className="text-body">{offer.email}</strong>. Sign in with
          that Google account to accept it.
        </p>
        <Link
          href={acceptPath}
          className="mt-4 inline-flex min-h-9 items-center rounded-hs bg-cta px-3 font-medium text-white no-underline hover:bg-cta-hover"
        >
          Continue to sign in
        </Link>
      </div>
      <p className="text-small text-secondary">
        Signing in with a different address will not accept this invitation.
      </p>
    </main>
  )
}

export default InvitePage
