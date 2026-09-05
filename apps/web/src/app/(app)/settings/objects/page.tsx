import { listCustomObjects } from '@rawr/db'
import { PageHeader } from '@rawr/ui'
import { contextFrom, readSession } from '~/server/session.ts'
import { ObjectList } from './object-list.tsx'

/** Objects an admin invents, beside the three Rawr is built on. */
const ObjectsPage = async () => {
  const session = await readSession()
  if (!session) return null

  const ctx = contextFrom(session)
  const rows = await listCustomObjects(ctx)

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Objects"
        lead="Contacts, companies and deals, and anything else you keep records of."
        why={
          <>
            <p>
              An object you create sits beside the built-in three with its own fields, its own list
              and its own records. Its values live in one shared table rather than a table of its
              own, which is why it needs no migration and no deploy — and why a very large one
              sorts a little more slowly than contacts do.
            </p>
            <p>
              Records of it have fields, filters, sorting and search. They do not have a timeline,
              associations or tasks yet: all three name a record type that is fixed to the three
              built-in objects, and widening that is its own change.
            </p>
          </>
        }
      />

      <ObjectList
        rows={rows.map((row) => ({
          id: row.id,
          key: row.key,
          nameSingular: row.nameSingular,
          namePlural: row.namePlural,
          fieldCount: row.fieldCount,
          recordCount: row.recordCount,
        }))}
        workspace={session.workspaceSlug}
        canWrite={session.role === 'admin'}
      />
    </div>
  )
}

export default ObjectsPage
