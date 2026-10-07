import { membershipsForUser } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { safePath } from '~/lib/links.ts'
import { readSession, sessionFromMembership, writeSessionCookie } from '~/server/session.ts'

/** Switches the signed-in account. A POST, so a link or an image cannot do it on
 *  somebody's behalf: the session cookie is not sent on a cross-site POST, and the
 *  origin is checked besides. Membership is re-read from the database here; the
 *  slug is a request, never proof. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const origin = request.headers.get('origin')
  if (origin && origin !== new URL(env.AUTH_URL).origin) return new NextResponse(null, { status: 403 })

  const session = await readSession()
  if (!session) {
    const back = new URL('/sign-in', env.AUTH_URL)
    back.searchParams.set('error', 'Sign in to open that link.')
    return NextResponse.redirect(back, 303)
  }

  const form = await request.formData().catch(() => null)
  if (!form) return new NextResponse(null, { status: 400 })
  const wanted = String(form.get('to') ?? '')
  const next = safePath(String(form.get('next') ?? ''))

  if (wanted === session.accountSlug) {
    return NextResponse.redirect(new URL(next, env.AUTH_URL), 303)
  }

  const memberships = await membershipsForUser(session.userId)
  const target = memberships.find((membership) => membership.accountSlug === wanted)
  if (!target) {
    const back = new URL('/', env.AUTH_URL)
    back.searchParams.set(
      'error',
      `That link belongs to an account called "${wanted}", and you do not have a seat in it.`,
    )
    return NextResponse.redirect(back, 303)
  }

  await writeSessionCookie(sessionFromMembership(target))
  return NextResponse.redirect(new URL(next, env.AUTH_URL), 303)
}
