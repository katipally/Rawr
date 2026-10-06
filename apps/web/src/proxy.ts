import { decodeJwt } from 'jose'
import { NextResponse, type NextRequest } from 'next/server'
import { fromHubspotPath } from '~/lib/links.ts'

/** A CRM or meetings link carries its account in the path, so opening someone else's link
 *  while signed in to a different account has to offer the switch rather than
 *  quietly show the wrong tenant's screen or 404. It only offers: the switch is a
 *  button on /switch, a POST, because moving the session under a tab that is still
 *  working in the other account sends that tab's next write to the wrong tenant.
 *
 *  The claim is only read here, never trusted: this decides whether to bother
 *  redirecting. The switch handler verifies the signature and the membership
 *  before it changes anything. */

// The slug ends at a slash, a query string or a fragment. Without the last two,
// /contacts/probe?tab=x captured "probe?tab=x" and the switch handler then
// refused an account by that name.
const ACCOUNT_PATH = /^\/(?:contacts|meetings)\/([^/?#]+)([/?#]|$)/

export const proxy = (request: NextRequest): NextResponse => {
  const readable = fromHubspotPath(request.nextUrl.pathname)
  if (readable) {
    // The answer can carry its own query (a segment builder, a form's submissions),
    // so the link's query is merged in rather than appended after it.
    const target = new URL(readable, request.nextUrl.origin)
    for (const [key, value] of request.nextUrl.searchParams) {
      if (!target.searchParams.has(key)) target.searchParams.append(key, value)
    }
    return NextResponse.redirect(target)
  }

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

  const switchTo = new URL('/switch', request.nextUrl.origin)
  switchTo.searchParams.set('to', wanted)
  // The whole original address, so the person lands on the record they were sent,
  // not on the account's front page.
  switchTo.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(switchTo)
}

export const config = {
  // /forms, /submissions, /email, /sequences, /templates, /reports-dashboard,
  // /reports-list, /import, /data-integration-home, /duplicates,
  // /connected-apps, /integrations-settings, /marketplace, /ecosystem and /user-home exist
  // only as HubSpot links to redirect; /settings is matched for HubSpot's
  // calendar preference link alone.
  matcher: [
    '/contacts/:path*',
    '/meetings/:path*',
    '/forms/:path*',
    '/submissions/:path*',
    '/email/:path*',
    '/sequences/:path*',
    '/templates/:path*',
    '/reports-dashboard/:path*',
    '/reports-list/:path*',
    '/import/:path*',
    '/data-integration-home/:path*',
    '/duplicates/:path*',
    '/connected-apps/:path*',
    '/integrations-settings/:path*',
    '/marketplace/:path*',
    '/ecosystem/:path*',
    '/user-home/:path*',
    '/settings/:path*',
  ],
}
