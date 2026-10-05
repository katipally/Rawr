import { canView, type Hub } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import type { ReactNode } from 'react'
import { contextFrom, readSession } from '~/server/session.ts'

/** What a screen shows a seat that holds neither grant for its hub. The data
 *  access layer refuses the reads either way; this is the sentence instead of a
 *  failed screen. */
export const HubGate = async ({ hub, what, children }: { hub: Hub; what: string; children: ReactNode }) => {
  const session = await readSession()
  if (session && !canView(contextFrom(session), hub)) {
    return (
      <EmptyState
        title={`${what} need ${hub} access`}
        description={`Your role does not include the ${hub} hub. Ask an admin to add it.`}
      />
    )
  }
  return children
}
