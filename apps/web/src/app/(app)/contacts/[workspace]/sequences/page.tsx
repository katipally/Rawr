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

  return <SequenceList workspace={workspace} rows={rows} canWrite={canWrite(session.role, 'sequence')} role={session.role} />
}

export default SequencesPage
