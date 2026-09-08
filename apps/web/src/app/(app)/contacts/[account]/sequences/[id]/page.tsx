import { canWrite, isUuid, listSubscriptionTypes, readSequence } from '@rawr/db'
import { notFound, redirect } from 'next/navigation'
import { contextFrom, readSession } from '~/server/session.ts'
import { SequenceEditor } from './editor.tsx'

/** One sequence: its steps, its rules, and how it is doing. */
const SequencePage = async ({ params }: { params: Promise<{ account: string; id: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, id } = await params
  if (!isUuid(id)) notFound()

  const ctx = contextFrom(session)
  const [found, types] = await Promise.all([readSequence(ctx, id), listSubscriptionTypes(ctx)])
  if (!found) notFound()

  return (
    <SequenceEditor
      account={account}
      sequence={found.sequence}
      steps={found.steps}
      variants={found.variants}
      subscriptionTypes={types.map((type) => ({ id: type.id, name: type.name }))}
      canWrite={canWrite(contextFrom(session), 'sequence')}
    />
  )
}

export default SequencePage
