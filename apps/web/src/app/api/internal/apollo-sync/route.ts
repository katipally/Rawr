import { publicEdgeContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { syncLinkedContacts } from '~/server/integrations/apollo.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to read Apollo's sequence activity back onto the
 *  timeline for one workspace. Same shape and reason as the mailbox endpoint:
 *  the credentials live here, so the call does too. F6 §3. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }
  const body = (await request.json().catch(() => null)) as { workspaceId?: string } | null
  if (!body?.workspaceId) return NextResponse.json({ error: 'A workspace is required.' }, { status: 400 })

  try {
    const outcome = await syncLinkedContacts({ ...publicEdgeContext(body.workspaceId), actorKind: 'job' })
    return NextResponse.json(outcome)
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 })
  }
}
