import { publicEdgeContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { testConnection } from '~/server/integrations/index.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to run one integration's connection test. F6 §1's
 *  scheduled health check.
 *
 *  Same shape and same reason as the mailbox endpoint: the provider clients live
 *  here because the credentials do, and one process holding them is one too few
 *  places to go wrong. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as
    | { accountId?: string; kind?: string }
    | null
  if (!body?.accountId || !body?.kind) {
    return NextResponse.json({ error: 'A account and a kind are both required.' }, { status: 400 })
  }

  const result = await testConnection(
    { ...publicEdgeContext(body.accountId), actorKind: 'job' },
    body.kind as never,
  )
  // Always 200: the worker wants the answer, not an HTTP error. A failing provider
  // is already recorded as a degraded health state by the test itself.
  return NextResponse.json(result)
}
