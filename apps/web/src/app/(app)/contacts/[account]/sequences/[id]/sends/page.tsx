import { isUuid, listSends, readSequence, SENDS_PAGE } from '@rawr/db'
import { notFound, redirect } from 'next/navigation'
import { contextFrom, readSession } from '~/server/session.ts'
import { SendTable } from './send-table.tsx'

const STATES = ['sent', 'failed', 'bounced'] as const

/** Every mail one sequence put on the wire.
 *
 *  The enrollments list answers "where has this person got to". This answers the
 *  other question a sequence raises: which message, on which step, was opened,
 *  clicked, replied to or bounced. Its own page because there is one row per
 *  contact per step, which is an order of magnitude more rows than there are
 *  people in the sequence, and it is paged at the database for the same reason. */
const SequenceSendsPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string; id: string }>
  searchParams: Promise<{ state?: string; skip?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, id } = await params
  const { state, skip } = await searchParams
  if (!isUuid(id)) notFound()

  const ctx = contextFrom(session)
  const chosen = STATES.find((each) => each === state) ?? null
  // A hand-edited offset lands on the first page rather than on an error.
  const offset = Math.max(0, Number(skip) || 0)

  const [found, page] = await Promise.all([
    readSequence(ctx, id),
    listSends(ctx, { sequenceId: id, state: chosen, limit: SENDS_PAGE, offset }),
  ])
  if (!found) notFound()

  return (
    <SendTable
      account={account}
      sequenceId={id}
      sequenceName={found.sequence.name}
      state={chosen}
      offset={offset}
      perPage={SENDS_PAGE}
      hasMore={page.hasMore}
      rows={page.rows.map((row) => ({ ...row, sentAt: row.sentAt.toISOString() }))}
    />
  )
}

export default SequenceSendsPage
