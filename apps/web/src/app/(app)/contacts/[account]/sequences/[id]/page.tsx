import { canWrite, isUuid, listMailboxes, listSubscriptionTypes, readSequence } from '@rawr/db'
import { Alert, buttonClass } from '@rawr/ui'
import { notFound, redirect } from 'next/navigation'
import { googleConfigured } from '~/lib/env.ts'
import { mailboxesPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { SequenceEditor } from './editor.tsx'

/** One sequence: its steps, its rules, and how it is doing. */
const SequencePage = async ({ params }: { params: Promise<{ account: string; id: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, id } = await params
  if (!isUuid(id)) notFound()

  const ctx = contextFrom(session)
  const [found, types, mailboxes] = await Promise.all([readSequence(ctx, id), listSubscriptionTypes(ctx), listMailboxes(ctx)])
  if (!found) notFound()
  const hasMailbox = mailboxes.some((box) => box.userId === session.userId && box.state !== 'revoked')

  return (
    <>
      {found.sequence.sender === 'gmail' && !hasMailbox ? (
        <Alert
          tone="warning"
          className="mb-4"
          action={
            <a href={googleConfigured ? '/api/auth/google/gmail?send=1' : mailboxesPath()} className={buttonClass('primary', 'no-underline')}>
              Connect mailbox
            </a>
          }
        >
          You have no mailbox connected, so enrolling contacts here sends nothing. Gmail sequences send from the enroller's own mailbox.
        </Alert>
      ) : null}
    <SequenceEditor
      account={account}
      sequence={found.sequence}
      steps={found.steps}
      variants={found.variants}
      subscriptionTypes={types.map((type) => ({ id: type.id, name: type.name }))}
      canWrite={canWrite(contextFrom(session), 'sequence')}
    />
    </>
  )
}

export default SequencePage
