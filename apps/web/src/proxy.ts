import { decodeJwt } from 'jose'
import { NextResponse, type NextRequest } from 'next/server'

/** A CRM or meetings link carries its account in the path, so opening someone else's link
 *  while signed in to a different account has to switch rather than quietly
 *  show the wrong tenant's screen or 404.
 *
 *  The claim is only read here, never trusted: this decides whether to bother
 *  redirecting. The switch handler verifies the signature and the membership
 *  before it changes anything. */

// The slug ends at a slash, a query string or a fragment. Without the last two,
// /contacts/probe?tab=x captured "probe?tab=x" and the switch handler then
// refused an account by that name.
const ACCOUNT_PATH = /^\/(?:contacts|meetings)\/([^/?#]+)([/?#]|$)/

export const proxy = (request: NextRequest): NextResponse => {
  const match = ACCOUNT_PATH.exec(request.nextUrl.pathname)
  if (!match) return NextResponse.next()

  const wanted = match[1]
  const token = request.cookies.get('rawr_session')?.value
  if (!wanted || !token) return NextResponse.next()

  let current: string | undefined
  try {
    current = decodeJwt<{ accountSlug?: string }>(token).accountSlug
  } catch {
    return NextResponse.next()
  }

  if (!current || current === wanted) return NextResponse.next()

  const switchTo = new URL('/api/auth/account', request.nextUrl.origin)
  switchTo.searchParams.set('to', wanted)
  // The whole original address, so the person lands on the record they were sent,
  // not on the account's front page.
  switchTo.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(switchTo)
}

/** The upload path is excluded rather than returned early from, because the cost
 *  is paid before this function runs: a matched request has its body buffered
 *  against `experimental.proxyClientMaxBodySize`, which defaults to 10MB and
 *  truncates rather than rejects. A 40MB export arrived cut in half with no error
 *  anywhere. Nothing under /contacts/:account/import/upload needs an account
 *  switch: the route checks the slug against the session itself.
 *
 *  Next compiles a `source` with path-to-regexp, where a parenthesised group is
 *  passed through as raw regex, so the negative lookahead is applied to the whole
 *  remainder of the path. */
export const config = {
  matcher: ['/contacts/((?!.*/import/upload$).*)', '/meetings/:path*'],
}
