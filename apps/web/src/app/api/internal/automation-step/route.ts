import { systemContext, accountSlugFor } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { resumeAutomation, scanAutomations } from '~/server/automations.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'

/** The worker asking the app to move an automation along.
 *
 *  Here rather than in the worker for the reason the sequence step is: the actions
 *  reach the Slack queue, the record writers and the audit log the app already
 *  owns, and a second copy of any of those is one too many.
 *
 *  Two things to ask for, and the run tells them apart. With a run, pick that
 *  parked one back up. Without, sweep the account for the triggers no write
 *  announces: a date that has arrived, a record that has gone quiet. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as
    | { accountId?: string; runId?: string }
    | null
  if (!body?.accountId) {
    return NextResponse.json({ error: 'An account is required.' }, { status: 400 })
  }

  try {
    // A job's context: no actor, marketing's ceiling. That is already what the
    // trigger path writes under, so a resumed step can do nothing a triggered
    // one could not.
    const ctx = systemContext(body.accountId)
    const slug = await accountSlugFor(ctx)
    return NextResponse.json(
      body.runId ? await resumeAutomation(ctx, body.runId, slug) : await scanAutomations(ctx, slug),
    )
  } catch (cause) {
    return NextResponse.json(
      { error: cause instanceof Error ? cause.message : String(cause) },
      { status: 500 },
    )
  }
}
