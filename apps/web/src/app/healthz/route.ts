import { databaseReachable } from '@rawr/db'
import { NextResponse } from 'next/server'

/** What a load balancer polls, and what keeps a free tier awake.
 *
 *  It touches the database on purpose. A check that only proves Node is running
 *  reports green through an expired password and an unreachable host, which is the
 *  outage it exists to catch -- and on a managed Postgres that pauses itself after
 *  a week of quiet, this query is also the thing that keeps it from pausing.
 *
 *  Never cached: a health check answered from last minute's cache is not one. */
export const dynamic = 'force-dynamic'

/** A driver puts the connection string in some of its messages, and this endpoint
 *  takes no session. Everything between the scheme and the host goes, which is
 *  where a password can be; the host and the reason stay, because "TypeError" on
 *  its own is not something anybody can act on. */
const withoutCredentials = (message: string): string =>
  message.replace(/[a-z+]+:\/\/[^\s/@]*@/gi, '***@')

/** Drizzle wraps a driver error as "Failed query: select 1", which says nothing
 *  about why. The reason an operator needs -- ENOTFOUND, ECONNREFUSED, password
 *  authentication failed -- is on the cause underneath, so unwrap to the innermost
 *  one before reporting. */
const reasonFor = (error: unknown): string => {
  let current = error
  while (current instanceof Error && current.cause instanceof Error) current = current.cause
  return current instanceof Error ? withoutCredentials(current.message) : 'unreachable'
}

export const GET = async (): Promise<NextResponse> => {
  const startedAt = Date.now()
  try {
    await databaseReachable()
  } catch (cause) {
    return NextResponse.json({ ok: false, database: reasonFor(cause) }, { status: 503 })
  }
  return NextResponse.json({ ok: true, databaseMs: Date.now() - startedAt })
}
