import { listDeadLetters } from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import { contextFrom, readSession } from '~/server/session.ts'
import { DeadLetterTable } from './table.tsx'

const JobsPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (session.role !== 'admin') {
    return (
      <EmptyState
        title="Workspace settings are admin only"
        description={`Your role (${session.role}) cannot open this page. Ask an admin in ${session.workspaceName} if you need access.`}
      />
    )
  }

  const rows = await listDeadLetters(contextFrom(session))

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-base font-medium">Failed jobs</h1>
        <p className="text-secondary">
          A job that exhausted its retries lands here with the payload and the real error. Replaying
          one puts the work back in the queue; the dispatcher picks it up within a minute.
        </p>
      </div>
      <DeadLetterTable
        rows={rows.map((row) => ({ ...row, at: row.at.toISOString() }))}
      />
    </div>
  )
}

export default JobsPage
