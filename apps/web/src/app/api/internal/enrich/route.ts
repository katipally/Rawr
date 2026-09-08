import { publicEdgeContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { enrichCompanyRecord, enrichRecord } from '~/server/integrations/index.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to enrich one record. Here rather than in the
 *  worker for the reason every other internal endpoint is: the provider
 *  credentials, the provenance rules and the suggestion table all live in the
 *  app, and a second copy of any of them is one too many. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }
  const body = (await request.json().catch(() => null)) as
    | { accountId?: string; entity?: string; entityId?: string }
    | null
  if (!body?.accountId || !body.entityId || (body.entity !== 'contact' && body.entity !== 'company')) {
    return NextResponse.json({ error: 'A account, an entity and a record are all required.' }, { status: 400 })
  }

  try {
    const ctx = { ...publicEdgeContext(body.accountId), actorKind: 'job' as const }
    const run = body.entity === 'contact' ? await enrichRecord(ctx, body.entityId) : await enrichCompanyRecord(ctx, body.entityId)
    return NextResponse.json(run)
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 })
  }
}
