import { Button, EmptyState } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { LinkButton } from '~/components/link-button.tsx'
import { accountHome, safePath } from '~/lib/links.ts'
import { memberships, readSession } from '~/server/session.ts'

/** Where a link into another of the person's accounts lands. Opening it must not
 *  move the session on its own: another tab may still be working in the current
 *  account, and a link is not a decision. Switching is the button, a POST. */
const SwitchPage = async ({ searchParams }: { searchParams: Promise<{ to?: string; next?: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { to = '', next } = await searchParams
  const path = safePath(next)
  if (to === session.accountSlug) redirect(path)

  const target = (await memberships(session.userId)).find((row) => row.accountSlug === to)
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 p-6">
      {target ? (
        <EmptyState
          title={`This link is in ${target.accountName}`}
          description={`You are in ${session.accountName}. Switching moves every open tab of Rawr to ${target.accountName}.`}
          action={
            <div className="flex gap-2">
              <form action="/api/auth/account" method="post">
                <input type="hidden" name="to" value={target.accountSlug} />
                <input type="hidden" name="next" value={path} />
                <Button type="submit" variant="primary">
                  Open {target.accountName}
                </Button>
              </form>
              <LinkButton href={accountHome(session.accountSlug)}>Stay in {session.accountName}</LinkButton>
            </div>
          }
        />
      ) : (
        <EmptyState
          title={`You do not have a seat in "${to}"`}
          description="That link belongs to another account. Ask an admin there to add you, or go back to your own."
          action={<LinkButton variant="primary" href={accountHome(session.accountSlug)}>Open {session.accountName}</LinkButton>}
        />
      )}
    </main>
  )
}

export default SwitchPage
