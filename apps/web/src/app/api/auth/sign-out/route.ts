import { NextResponse } from 'next/server'
import { env } from '~/lib/env.ts'
import { clearSessionCookie } from '~/server/session.ts'

export const POST = async (): Promise<NextResponse> => {
  await clearSessionCookie()
  return NextResponse.redirect(new URL('/sign-in', env.AUTH_URL))
}
