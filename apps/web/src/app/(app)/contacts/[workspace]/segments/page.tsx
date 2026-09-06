import { getRegistry, listSegments, type ObjectKey } from '@rawr/db'
import { redirect } from 'next/navigation'
import { toFilterFields } from '~/server/crm.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { SegmentList } from './segment-list.tsx'

/** D15. A segment is a saved query with remembered membership: entering and leaving
 *  are timeline events, and F6 pushes one to Brevo as a list. */
const SegmentsPage = async ({ params }: { params: Promise<{ workspace: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace } = await params
  const ctx = contextFrom(session)
  const [segments, registry] = await Promise.all([listSegments(ctx), getRegistry(ctx)])

  const fieldsByObject = Object.fromEntries(
    (['contact', 'company', 'deal'] as ObjectKey[]).flatMap((key) => {
      const object = registry.byKey.get(key)
      return object ? [[key, toFilterFields(object)]] : []
    }),
  )

  return (
    <SegmentList
      workspace={workspace}
      rows={segments.map((row) => ({
        ...row,
        lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
      }))}
      fieldsByObject={fieldsByObject}
      canWrite={['admin', 'marketing'].includes(session.role)}
      role={session.role}
    />
  )
}

export default SegmentsPage
