import { createOauthCode } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { checkAuthorizeRequest, issuer } from '~/server/mcp/oauth.ts'
import { memberships, readSession } from '~/server/session.ts'

/** The Approve or Cancel press on the consent screen. The request is checked
 *  again here rather than trusted from the form, because the form is the
 *  browser's and the code is ours.
 *
 *  Every redirect out of here is 303, not the 307 NextResponse.redirect defaults
 *  to. A 307 preserves the method, so approving re-posted the whole consent form
 *  to the client's own redirect URI: an OAuth client expects a GET there, and the
 *  form fields have no business being sent to it. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const origin = await issuer()
  const session = await readSession()
  if (!session) return NextResponse.redirect(new URL('/sign-in', origin), 303)

  const form = await request.formData()
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
    return NextResponse.redirect(back, 303)
  }

  // The account comes from the person's own memberships, never from the form
  // alone: an account id they are not a member of is refused.
  const chosen = params.get('account_id') ?? session.accountId
  const membership = (await memberships(session.userId)).find((m) => m.accountId === chosen)
  if (!membership) {
    back.searchParams.set('error', 'access_denied')
    back.searchParams.set('error_description', 'That account is not one this account belongs to.')
    return NextResponse.redirect(back, 303)
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
  return NextResponse.redirect(back, 303)
}
