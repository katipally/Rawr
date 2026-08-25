import { decodeJwt } from 'jose'
import { NextResponse, type NextRequest } from 'next/server'

/** A CRM link carries its workspace in the path, so opening someone else's link
 *  while signed in to a different workspace has to switch rather than quietly
 *  show the wrong tenant's screen or 404.
 *
 *  The claim is only read here, never trusted: this decides whether to bother
 *  redirecting. The switch handler verifies the signature and the membership
 *  before it changes anything. */

const CRM_PATH = /^\/contacts\/([^/]+)(\/|$)/

export const proxy = (request: NextRequest): NextResponse => {
  const match = CRM_PATH.exec(request.nextUrl.pathname)
  if (!match) return NextResponse.next()

  const wanted = match[1]
  const token = request.cookies.get('rawr_session')?.value
  if (!wanted || !token) return NextResponse.next()

  let current: string | undefined
  try {
    current = decodeJwt<{ workspaceSlug?: string }>(token).workspaceSlug
  } catch {
    return NextResponse.next()
  }

  if (!current || current === wanted) return NextResponse.next()

  const switchTo = new URL('/api/auth/workspace', request.nextUrl.origin)
  switchTo.searchParams.set('to', wanted)
  // The whole original address, so the person lands on the record they were sent,
  // not on the workspace's front page.
  switchTo.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(switchTo)
}

export const config = { matcher: '/contacts/:path*' }
