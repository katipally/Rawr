import { getRegistry, readSegment, readSegmentMembers } from '@rawr/db'
import { notFound, redirect } from 'next/navigation'
import { readLookups, toFilterFields } from '~/server/crm.ts'
import { contextFrom, readSession, sessionCanEdit } from '~/server/session.ts'
import { ListMembers } from './list-members.tsx'

/** One segment, and who is in it. Every kind has this page, as in HubSpot; only
 *  a static list's members are edited here, because an active one's membership
 *  is its conditions and editing it would be editing a number rather than the
 *  rule behind it. */
/** One screenful, defined here rather than in the client module beside it: a
 *  value exported across the 'use client' boundary arrives as a module reference
 *  and reached the query as NaN. */
const PAGE_SIZE = 25

const SegmentPage = async ({ params }: { params: Promise<{ account: string; id: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, id } = await params
  const ctx = contextFrom(session)
  const [list, registry, lookups] = await Promise.all([readSegment(ctx, id), getRegistry(ctx), readLookups(ctx)])
  if (!list) notFound()

  const members = await readSegmentMembers(ctx, id, PAGE_SIZE)
  const object = registry.byKey.get(list.objectKey)

  return (
    <ListMembers
      account={account}
      list={{ ...list, lastEvaluatedAt: list.lastEvaluatedAt?.toISOString() ?? null }}
      fields={object ? toFilterFields(object, lookups) : []}
      initial={members.map((member) => ({ ...member, enteredAt: member.enteredAt.toISOString() }))}
      pageSize={PAGE_SIZE}
      canWrite={sessionCanEdit(session, 'marketing')}
    />
  )
}

export default SegmentPage
