import { readSegment, readSegmentMembers } from '@rawr/db'
import { notFound, redirect } from 'next/navigation'
import { contextFrom, readSession, sessionCanEdit } from '~/server/session.ts'
import { ListMembers, PAGE_SIZE } from './list-members.tsx'

/** One list, and who is in it.
 *
 *  A static list is the only kind whose membership is a thing a person edits, so
 *  it is the only kind with a page of its own. An active list opens as a filtered
 *  view instead, because its membership is its conditions and editing it here
 *  would be editing a number rather than the rule behind it. */
const SegmentPage = async ({ params }: { params: Promise<{ account: string; id: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, id } = await params
  const ctx = contextFrom(session)
  const list = await readSegment(ctx, id)
  if (!list) notFound()

  const members = await readSegmentMembers(ctx, id, PAGE_SIZE)

  return (
    <ListMembers
      account={account}
      list={{
        id: list.id,
        name: list.name,
        description: list.description,
        objectKey: list.objectKey,
        isStatic: list.isStatic,
        memberCount: list.memberCount,
      }}
      initial={members.map((member) => ({ ...member, enteredAt: member.enteredAt.toISOString() }))}
      canWrite={sessionCanEdit(session, 'marketing')}
    />
  )
}

export default SegmentPage
