import { createOauthCode } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { checkAuthorizeRequest, ISSUER } from '~/server/mcp/oauth.ts'
import { memberships, readSession } from '~/server/session.ts'

/** The Approve or Cancel press on the consent screen. The request is checked
 *  again here rather than trusted from the form, because the form is the
 *  browser's and the code is ours. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const session = await readSession()
  if (!session) return NextResponse.redirect(new URL('/sign-in', ISSUER))

  const form = await request.formData()
  const params = new URLSearchParams()
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params.set(key, value)
  }

  const checked = await checkAuthorizeRequest(params)
  if (!checked.ok) {
    return NextResponse.redirect(new URL(`/oauth/authorize?${params.toString()}`, ISSUER))
  }
  const { request: asked } = checked

  const back = new URL(asked.redirectUri)
  if (asked.state) back.searchParams.set('state', asked.state)
  // RFC 9207: the client checks who answered before it redeems anything.
  back.searchParams.set('iss', ISSUER)

  if (params.get('decision') !== 'approve') {
    back.searchParams.set('error', 'access_denied')
    back.searchParams.set('error_description', 'The person did not approve the connection.')
    return NextResponse.redirect(back)
  }

  // The workspace comes from the person's own memberships, never from the form
  // alone: a workspace id they are not a member of is refused.
  const chosen = params.get('workspace_id') ?? session.workspaceId
  const membership = (await memberships(session.userId)).find((m) => m.workspaceId === chosen)
  if (!membership) {
    back.searchParams.set('error', 'access_denied')
    back.searchParams.set('error_description', 'That workspace is not one this account belongs to.')
    return NextResponse.redirect(back)
  }

  const code = await createOauthCode(
    { workspaceId: membership.workspaceId, actorId: session.userId, actorKind: 'user', role: membership.role },
    {
      clientId: asked.clientId,
      codeChallenge: asked.codeChallenge,
      redirectUri: asked.redirectUri,
      resource: asked.resource,
      scope: asked.scope,
    },
  )
  back.searchParams.set('code', code)
  return NextResponse.redirect(back)
}
