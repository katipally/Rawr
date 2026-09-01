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
    <div className="flex flex-col gap-4">
      <div className="max-w-2xl">
        <h1 className="text-lg font-medium">Segments</h1>
        <p className="text-secondary">
          A saved query that remembers who is in it. Membership is recomputed on a schedule and
          whenever you ask; entering and leaving both land on the record&apos;s timeline, so a
          contact who left last month still shows why they are no longer being mailed.
        </p>
      </div>

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
    </div>
  )
}

export default SegmentsPage
