import { acceptInvitation, membershipsForUser, userIdForEmail } from '@rawr/db'
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { devLoginEnabled, env } from '~/lib/env.ts'
import { INVITE_COOKIE } from '~/server/invite.ts'
import { sessionFromMembership, writeSessionCookie } from '~/server/session.ts'
import { safeNext } from '~/server/auth/next.ts'

const back = (error: string): NextResponse =>
  NextResponse.redirect(new URL(`/sign-in?error=${encodeURIComponent(error)}`, env.AUTH_URL))

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!devLoginEnabled) {
    return NextResponse.json({ error: 'Dev sign-in is not enabled here.' }, { status: 404 })
  }

  const form = await request.formData()
  const email = String(form.get('email') ?? '').trim()
  const workspaceSlug = String(form.get('workspace') ?? '').trim()
  if (!email) return back('Enter an email address.')

  const userId = await userIdForEmail(email)
  // The same invitation path the Google callback takes, so the flow can be walked
  // in development without a real Google account.
  const jar = await cookies()
  const inviteToken = jar.get(INVITE_COOKIE)?.value
  if (userId && inviteToken) {
    await acceptInvitation(inviteToken, userId)
    jar.delete(INVITE_COOKIE)
  }
  const memberships = userId ? await membershipsForUser(userId) : []
  const membership = workspaceSlug
    ? memberships.find((m) => m.workspaceSlug === workspaceSlug)
    : memberships[0]

  if (!membership) {
    const detail = workspaceSlug ? ` in workspace ${workspaceSlug}` : ''
    return back(`No seeded user ${email}${detail}. Run pnpm db:seed.`)
  }

  await writeSessionCookie(sessionFromMembership(membership))
  return NextResponse.redirect(new URL(safeNext(String(form.get('next') ?? '')), env.AUTH_URL))
}
