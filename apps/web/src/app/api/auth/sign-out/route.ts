import { NextResponse } from 'next/server'
import { env } from '~/lib/env.ts'
import { clearSessionCookie } from '~/server/session.ts'

/** 303, not the 307 NextResponse.redirect defaults to. A 307 preserves the method,
 *  so signing out re-posted this form to /sign-in and left that page as the result
 *  of a POST: a refresh asked to submit again, and the back button was a mess. See
 *  Other is what turns a form post into a plain GET of the next page. */
export const POST = async (): Promise<NextResponse> => {
  await clearSessionCookie()
  return NextResponse.redirect(new URL('/sign-in', env.AUTH_URL), 303)
}
