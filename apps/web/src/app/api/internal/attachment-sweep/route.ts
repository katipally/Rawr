import { sweepAbandonedUploads, systemContext } from '@rawr/db'
import { NextResponse, type NextRequest } from 'next/server'
import { env } from '~/lib/env.ts'
import { describe, logError } from '~/server/log.ts'
import { isMissingObject } from '~/server/attachment-sweep.ts'
import { internalRequestIsAuthentic } from '~/server/internal.ts'
import { removeObject } from '~/server/storage.ts'

/** The worker asking the app to clear one account's abandoned attachment uploads: the
 *  bytes from storage, then the rows. The storage client lives here, so the worker
 *  names the account and nothing else. A failed removal keeps its row for the next pass. */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!internalRequestIsAuthentic(request, env.RAWR_INTERNAL_SECRET)) {
    return NextResponse.json({ error: 'Not for you.' }, { status: 404 })
  }

  const body = (await request.json().catch(() => null)) as { accountId?: string } | null
  if (!body?.accountId) return NextResponse.json({ error: 'An account is required.' }, { status: 400 })

  try {
    const { removed, failed } = await sweepAbandonedUploads(systemContext(body.accountId), (storageKey) =>
      removeObject(storageKey).catch((cause) => {
        if (!isMissingObject(cause)) throw cause
      }),
    )
    for (const failure of failed) {
      logError({ msg: 'an abandoned attachment could not be removed from storage', error: describe(failure.error) })
    }
    return NextResponse.json({ removed, failed: failed.length })
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : String(cause) }, { status: 500 })
  }
}
