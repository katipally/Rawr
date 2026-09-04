import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { generateCodeVerifier, generateState, googleClient, SIGN_IN_SCOPES } from '~/server/auth/google.ts'
import { safeNext } from '~/server/auth/next.ts'

export const GET = async (request: NextRequest): Promise<NextResponse> => {
  const state = generateState()
  const codeVerifier = generateCodeVerifier()
  const url = googleClient().createAuthorizationURL(state, codeVerifier, SIGN_IN_SCOPES)
  url.searchParams.set('hd', env.GOOGLE_HOSTED_DOMAIN)

  const jar = await cookies()
  const options = {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: 600,
  } as const
  jar.set('rawr_oauth_state', state, options)
  jar.set('rawr_oauth_verifier', codeVerifier, options)
  jar.set('rawr_next', safeNext(request.nextUrl.searchParams.get('next')), options)

  return NextResponse.redirect(url)
}

