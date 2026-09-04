import { listSequences } from '@rawr/db'
import { redirect } from 'next/navigation'
import { contextFrom, readSession } from '~/server/session.ts'
import { SequenceList } from './sequence-list.tsx'
import { canWrite } from '@rawr/db'

/** Multi-step outreach, sent from the member's own Gmail. */
const SequencesPage = async ({ params }: { params: Promise<{ workspace: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace } = await params
  const rows = await listSequences(contextFrom(session))

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="max-w-2xl">
        <h1 className="text-lg font-medium">Sequences</h1>
        <p className="text-secondary">
          A run of emails and tasks, sent from your own Gmail so the mail comes from you and lands in
          the same conversation as everything else. A reply stops it on the sync that reads the reply.
        </p>
      </div>

      <SequenceList workspace={workspace} rows={rows} canWrite={canWrite(session.role, 'sequence')} role={session.role} />
    </div>
  )
}

export default SequencesPage
