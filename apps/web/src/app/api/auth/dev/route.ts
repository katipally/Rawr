import { membershipsForGoogleSub } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { devLoginEnabled, env } from '~/lib/env.ts'
import { sessionFromMembership, writeSessionCookie } from '~/server/session.ts'

/** The seeded stand-in for a Google subject. Real Google subjects are numeric, so
 *  a dev identity can never collide with one. */
export const devGoogleSub = (email: string): string => `dev:${email.trim().toLowerCase()}`

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!devLoginEnabled) {
    return NextResponse.json({ error: 'Dev sign-in is not enabled here.' }, { status: 404 })
  }

  const form = await request.formData()
  const email = String(form.get('email') ?? '')
  const workspaceSlug = String(form.get('workspace') ?? '')
  if (!email) {
    return NextResponse.redirect(new URL('/sign-in?error=Enter+an+email+address.', env.AUTH_URL))
  }

  const memberships = await membershipsForGoogleSub(devGoogleSub(email))
  const membership = workspaceSlug
    ? memberships.find((m) => m.workspaceSlug === workspaceSlug)
    : memberships[0]

  if (!membership) {
    const detail = workspaceSlug ? ` in workspace ${workspaceSlug}` : ''
    return NextResponse.redirect(
      new URL(
        `/sign-in?error=${encodeURIComponent(`No seeded user ${email}${detail}. Run pnpm db:seed.`)}`,
        env.AUTH_URL,
      ),
    )
  }

  await writeSessionCookie(sessionFromMembership(devGoogleSub(email), membership))
  return NextResponse.redirect(new URL('/', env.AUTH_URL))
}
