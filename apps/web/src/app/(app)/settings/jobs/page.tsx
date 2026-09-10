import { listDeadLetters, queueHealth } from '@rawr/db'
import { Alert, EmptyState, PageHeader } from '@rawr/ui'
import { formatDateTime } from '~/components/crm/value.tsx'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { DeadLetterTable } from './table.tsx'

/** How long the dispatcher may be quiet before it is worth saying so. Generous on
 *  purpose: this deployment sleeps when nobody is using it, so a quiet half hour
 *  at three in the morning is the container behaving, not the worker dying. A line
 *  that cries wolf every night is a line people stop reading. */
const QUIET_MS = 30 * 60_000

const JobsPage = async () => {
  const session = await readSession()
  if (!session) return null

  if (!sessionIsAdmin(session)) {
    return (
      <EmptyState
        title="Account settings are admin only"
        description={`This page needs account access, which you do not have. Ask an admin in ${session.accountName} for it.`}
      />
    )
  }

  const ctx = contextFrom(session)
  const [rows, queue] = await Promise.all([listDeadLetters(ctx), queueHealth()])

  const quiet = queue.lastCompletedAt === null || Date.now() - queue.lastCompletedAt.getTime() > QUIET_MS
  const worrying = quiet && queue.waiting > 0

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Failed jobs"
        lead="A job that ran out of retries, with its payload and the real error."
        why={
          <>
            <p>
              Replaying one puts the work back in the queue; the dispatcher picks it up within a
              minute.
            </p>
            <p>
              The line above the table is the dispatcher itself. An empty table says nothing has
              failed, which is the same picture as nothing running at all, so the last job it
              finished is shown separately.
            </p>
          </>
        }
      />

      {/* Three states, not two. "Quiet" is normal here: this deployment sleeps
          when nobody is using it and wakes on the next request. Quiet with work
          waiting is the one that is actually wrong. */}
      {!queue.readable ? (
        <Alert tone="warning">
          The queue cannot be read from here, so whether the worker is running is unknown. Run the
          migration that grants it, then reload.
        </Alert>
      ) : worrying ? (
        <Alert tone="warning">
          {queue.waiting === 1 ? '1 job is waiting' : `${queue.waiting} jobs are waiting`} and
          nothing has finished{' '}
          {queue.lastCompletedAt
            ? `since ${formatDateTime(queue.lastCompletedAt, session.timezone)}`
            : 'at all'}
          . The worker is not picking work up.
        </Alert>
      ) : (
        <p className="text-secondary">
          {queue.lastCompletedAt
            ? `Dispatcher last finished a job ${formatDateTime(queue.lastCompletedAt, session.timezone)}.`
            : 'The dispatcher has not finished a job yet.'}
          {queue.waiting > 0
            ? ` ${queue.waiting === 1 ? '1 job is' : `${queue.waiting} jobs are`} waiting.`
            : ' Nothing is waiting.'}
          {quiet && queue.waiting === 0
            ? ' Quiet is normal when nobody is using the app: it sleeps and wakes on the next request.'
            : ''}
        </p>
      )}

      <DeadLetterTable
        rows={rows.map((row) => ({ ...row, at: row.at.toISOString() }))}
      />
    </div>
  )
}

export default JobsPage
