import { listDeadLetters } from '@rawr/db'
import { EmptyState, PageHeader } from '@rawr/ui'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { DeadLetterTable } from './table.tsx'

const JobsPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (!sessionIsAdmin(session)) {
    return (
      <EmptyState
        title="Account settings are admin only"
        description={`You need account access, which you do not have. cannot open this page. Ask an admin in ${session.accountName} if you need access.`}
      />
    )
  }

  const rows = await listDeadLetters(contextFrom(session))

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Failed jobs"
        lead="A job that ran out of retries, with its payload and the real error."
        why={
          <p>
            Replaying one puts the work back in the queue; the dispatcher picks it up within a
            minute.
          </p>
        }
      />
      <DeadLetterTable
        rows={rows.map((row) => ({ ...row, at: row.at.toISOString() }))}
      />
    </div>
  )
}

export default JobsPage
