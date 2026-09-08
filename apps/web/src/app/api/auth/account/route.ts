import { membershipsForUser } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { readSession, sessionFromMembership, writeSessionCookie } from '~/server/session.ts'

/** Switches the signed-in account so a link into another tenant opens where it
 *  was meant to. Membership is re-read from the database here; the slug in the URL
 *  is a request, never proof. */
export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const session = await readSession()
  if (!session) {
    const back = new URL('/sign-in', env.AUTH_URL)
    back.searchParams.set('error', 'Sign in to open that link.')
    return NextResponse.redirect(back)
  }

  const wanted = request.nextUrl.searchParams.get('to') ?? ''
  const requested = request.nextUrl.searchParams.get('next') ?? '/'
  // Only same-origin paths, so this cannot be turned into an open redirect.
  const next = requested.startsWith('/') && !requested.startsWith('//') ? requested : '/'

  if (wanted === session.accountSlug) {
    return NextResponse.redirect(new URL(next, env.AUTH_URL))
  }

  const memberships = await membershipsForUser(session.userId)
  const target = memberships.find((membership) => membership.accountSlug === wanted)
  if (!target) {
    const back = new URL('/', env.AUTH_URL)
    back.searchParams.set(
      'error',
      `That link belongs to a account called "${wanted}", and this account is not a member of it.`,
    )
    return NextResponse.redirect(back)
  }

  await writeSessionCookie(sessionFromMembership(target))
  return NextResponse.redirect(new URL(next, env.AUTH_URL))
}
