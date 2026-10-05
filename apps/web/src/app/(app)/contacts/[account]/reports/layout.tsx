import type { ReactNode } from 'react'
import { HubGate } from '~/components/hub-gate.tsx'
import { ZoneProvider } from '~/components/zone.tsx'
import { readSession } from '~/server/session.ts'

/** B7. Six reports behind one frame. The header is rendered by each page rather
 *  than here, because only a page is given the query string the range lives in.
 *
 *  Everything below reads its times in the account's zone, the one the reports
 *  bucket their days in, so a send at 9:21 PM is on the same day in the chart and
 *  in the table under it. */
const ReportsLayout = async ({ children }: { children: ReactNode }) => {
  const session = await readSession()
  return (
    <HubGate hub="reports" what="Reports">
      <ZoneProvider zone={session?.accountTimezone ?? 'UTC'}>
        <div className="flex min-w-0 flex-col gap-4">{children}</div>
      </ZoneProvider>
    </HubGate>
  )
}

export default ReportsLayout
