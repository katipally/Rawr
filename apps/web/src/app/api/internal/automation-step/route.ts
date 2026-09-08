import { publicEdgeContext, accountSlugFor } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { resumeAutomation } from '~/server/automations.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to pick a parked automation back up.
 *
 *  Here rather than in the worker for the reason the sequence step is: the actions
 *  reach the Slack queue, the record writers and the audit log the app already
 *  owns, and a second copy of any of those is one too many. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as
    | { accountId?: string; runId?: string }
    | null
  if (!body?.accountId || !body?.runId) {
    return NextResponse.json({ error: 'A account and a run are both required.' }, { status: 400 })
  }

  try {
    // A job's context: no actor, marketing's ceiling. That is already what the
    // trigger path writes under, so a resumed step can do nothing a triggered
    // one could not.
    const ctx = { ...publicEdgeContext(body.accountId), actorKind: 'job' as const }
    return NextResponse.json(await resumeAutomation(ctx, body.runId, await accountSlugFor(ctx)))
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}
