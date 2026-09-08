import { recordConsent, accountIdForSite } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { readCategories } from '~/server/consent.ts'
import {
  checkSubmitLimits,
  clientIp,
  CORS_HEADERS,
  ipHashOf,
  PayloadTooLarge,
  readBody,
} from '~/server/edge.ts'

/** POST /c — a visitor's consent choice, stored as evidence.
 *
 *  The cookie is what governs behaviour in the browser; this row is the record
 *  that a choice was made, under which policy version, and when. Losing the row
 *  must never break the banner, so every failure here answers 204 and the client
 *  never retries: the cookie has already been written by the time this is called. */

export const OPTIONS = (): NextResponse =>
  new NextResponse(null, { status: 204, headers: CORS_HEADERS })

const done = (): NextResponse => new NextResponse(null, { status: 204, headers: CORS_HEADERS })

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const ip = clientIp(request)
  const limit = checkSubmitLimits('consent', ip)
  if (!limit.allowed) return done()

  let body: Record<string, unknown>
  try {
    body = await readBody(request)
  } catch (cause) {
    if (cause instanceof PayloadTooLarge) return done()
    return done()
  }

  const site = typeof body.site === 'string' ? body.site : null
  const visitorId = typeof body.visitorId === 'string' ? body.visitorId : null
  const categories = readCategories(body.categories)
  if (!site || !categories) return done()

  // Declining analytics means no visitor id exists, and that is the correct
  // outcome rather than a failure: nothing was collected, so there is nothing to
  // key a consent row to. The cookie still holds the choice.
  if (!visitorId) return done()

  const accountId = await accountIdForSite(site)
  if (!accountId) return done()

  try {
    await recordConsent(accountId, {
      visitorId,
      categories,
      policyVersion:
        typeof body.policyVersion === 'string' ? body.policyVersion : env.CONSENT_POLICY_VERSION,
      ipHash: ipHashOf(request),
      userAgent: request.headers.get('user-agent'),
    })
  } catch {
    // Deliberately swallowed. A banner that surfaces a database error at a
    // visitor is worse than a missing row we can re-derive from their cookie.
  }

  return done()
}
