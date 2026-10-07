import { createOauthCode } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { checkAuthorizeRequest, issuer, oauthError } from '~/server/mcp/oauth.ts'
import { hopResponse } from '~/server/redirect-hop.ts'
import { crossOrigin } from '~/server/same-origin.ts'
import { memberships, readSession } from '~/server/session.ts'

/** The Approve or Cancel press on the consent screen. The request is checked
 *  again here rather than trusted from the form, because the form is the
 *  browser's and the code is ours.
 *
 *  Redirects to this site are 303, not the 307 NextResponse.redirect defaults to,
 *  which would re-post the form. The way back to the client is not a redirect at
 *  all: form-action 'self' makes Chrome refuse a cross-origin one after a form
 *  post, so it is a page that navigates there (see redirect-hop.ts). */
export const POST = async (request: NextRequest): Promise<Response> => {
  const origin = await issuer()
  if (crossOrigin(request, origin)) return new NextResponse(null, { status: 403 })
  const session = await readSession()
  if (!session) return NextResponse.redirect(new URL('/sign-in', origin), 303)

  const form = await request.formData().catch(() => null)
  if (!form) return oauthError('invalid_request', 'The request body could not be read.')
  const params = new URLSearchParams()
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params.set(key, value)
  }

  const checked = await checkAuthorizeRequest(params)
  if (!checked.ok) {
    return NextResponse.redirect(new URL(`/oauth/authorize?${params.toString()}`, origin), 303)
  }
  const { request: asked } = checked

  const back = new URL(asked.redirectUri)
  if (asked.state) back.searchParams.set('state', asked.state)
  // RFC 9207: the client checks who answered before it redeems anything.
  back.searchParams.set('iss', origin)

  if (params.get('decision') !== 'approve') {
    back.searchParams.set('error', 'access_denied')
    back.searchParams.set('error_description', 'The person did not approve the connection.')
    return hopResponse(back)
  }

  // The account comes from the person's own memberships, never from the form
  // alone: an account id they are not a member of is refused.
  const chosen = params.get('account_id') ?? session.accountId
  const membership = (await memberships(session.userId)).find((m) => m.accountId === chosen)
  if (!membership) {
    back.searchParams.set('error', 'access_denied')
    back.searchParams.set('error_description', 'That account is not one this account belongs to.')
    return hopResponse(back)
  }

  const code = await createOauthCode(
    {
      accountId: membership.accountId,
      actorId: session.userId,
      actorKind: 'user',
      isSuperAdmin: membership.isSuperAdmin,
      viewHubs: membership.viewHubs,
      editHubs: membership.editHubs,
    },
    {
      clientId: asked.clientId,
      codeChallenge: asked.codeChallenge,
      redirectUri: asked.redirectUri,
      resource: asked.resource,
      scope: asked.scope,
    },
  )
  back.searchParams.set('code', code)
  return hopResponse(back)
}
