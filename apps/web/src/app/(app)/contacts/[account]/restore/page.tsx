import { canDo, getRegistry, listDeletedRecords } from '@rawr/db'
import { Breadcrumb, EmptyState, PageHeader, Tabs } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { RestoreList } from './restore-list.tsx'
import { restorePath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'

const LIMIT = 50

/** The way back from a delete. A delete here is soft, so what a person removed by
 *  mistake is still in the database; this is where they get it. Restoring needs the
 *  same grant deleting does, because it undoes it. */
const RestorePage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ object?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  if (!canDo(ctx, 'delete')) {
    return (
      <EmptyState
        title="Restoring is not something your role does"
        description="Putting back a deleted record needs the permission to delete, which your role does not have."
      />
    )
  }

  const { account } = await params
  const { object: raw } = await searchParams
  const { objects } = await getRegistry(ctx)
  const object = objects.find((candidate) => candidate.key === raw) ?? objects.find((candidate) => candidate.key === 'contact') ?? objects[0]
  if (!object) return <EmptyState title="Nothing to restore" description="This account has no record types." />

  const deleted = await listDeletedRecords(ctx, object.key, { limit: LIMIT })

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb items={[{ label: 'Data Management' }, { label: 'Restore records' }]} />

      <PageHeader
        title="Restore records"
        lead="Records somebody deleted, newest first, and the way to put them back."
        why={
          <p>
            Deleting hides a record everywhere, but nothing is erased: its timeline, its
            associations and its properties are all still there, so restoring brings back exactly
            what was hidden. A record that was merged into another is not listed, because the merge
            moved everything it held. One whose email or domain has since been taken by another
            record cannot come back until that one is merged or changed.
          </p>
        }
      />

      <Tabs
        label="Which records"
        items={objects.map((candidate) => ({
          key: candidate.key,
          label: candidate.namePlural,
          href: restorePath(account, candidate.key),
          current: candidate.key === object.key,
        }))}
      />

      <RestoreList
        // A different object is a different list, so the client state starts over.
        key={object.key}
        object={object.key}
        objectLabel={object.nameSingular}
        objectPlural={object.namePlural}
        limit={LIMIT}
        initial={{ total: deleted.total, rows: deleted.rows.map((row) => ({ ...row, deletedAt: row.deletedAt.toISOString() })) }}
      />
    </div>
  )
}

export default RestorePage
