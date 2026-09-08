import { listCustomObjects } from '@rawr/db'
import { PageHeader } from '@rawr/ui'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
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
              Records of it carry what a contact does: fields, filters, sorting, search, a
              timeline, associations to any other object, tasks and files. Automations can watch
              one being created, webhooks can announce it, and an agent on the MCP endpoint reaches
              it through the same tools it reaches a deal through.
            </p>
            <p>
              Three things stay with the built-in three, because each one works off a shape written
              per object rather than a general one: merging two records, enriching from an email or
              a domain, and importing a file.
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
        account={session.accountSlug}
        canWrite={sessionIsAdmin(session)}
      />
    </div>
  )
}

export default ObjectsPage
