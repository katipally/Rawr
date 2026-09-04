import { canWrite, isUuid, listEnrollments, readSequence } from '@rawr/db'
import { notFound, redirect } from 'next/navigation'
import { contextFrom, readSession } from '~/server/session.ts'
import { EnrollmentTable } from './enrollment-table.tsx'

const STATES = [
  'active',
  'waiting_task',
  'paused',
  'finished',
  'replied',
  'bounced',
  'unsubscribed',
  'failed',
  'removed',
] as const

/** Who is in one sequence, and where each of them got to. */
const EnrollmentsPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; id: string }>
  searchParams: Promise<{ state?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace, id } = await params
  const { state } = await searchParams
  if (!isUuid(id)) notFound()

  const ctx = contextFrom(session)
  const chosen = STATES.find((each) => each === state) ?? null
  const [found, rows] = await Promise.all([
    readSequence(ctx, id),
    listEnrollments(ctx, { sequenceId: id, state: chosen, limit: 200 }),
  ])
  if (!found) notFound()

  return (
    <EnrollmentTable
      workspace={workspace}
      sequenceId={id}
      sequenceName={found.sequence.name}
      state={chosen}
      rows={rows.map((row) => ({
        ...row,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        lastSentAt: row.lastSentAt?.toISOString() ?? null,
      }))}
      canWrite={canWrite(session.role, 'sequence_enrollment')}
    />
  )
}

export default EnrollmentsPage
