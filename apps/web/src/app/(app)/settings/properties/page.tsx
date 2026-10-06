import { getRegistry, listDeletedFields, listFields, objectOrThrow, rowsOf, tableFor, withAccount } from '@rawr/db'
import { PageHeader } from '@rawr/ui'
import { sql } from 'drizzle-orm'
import { toFilterFields } from '~/server/crm.ts'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { PropertyList } from './property-list.tsx'

/** HubSpot names the object by its type id, `?type=0-1`, on a link copied out of
 *  its property settings. */
const HUBSPOT_TYPES: Record<string, string> = { '0-1': 'contact', '0-2': 'company', '0-3': 'deal' }

/** D4's premise, made reachable: marketing adds a property without a deploy.
 *
 *  Every field created here is stored in <object>.custom as jsonb and appears
 *  immediately in the record editor, the filter builder, CSV import and export, and
 *  the MCP tool schema, because all of those read the same registry. */
const PropertiesPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ object?: string; type?: string }>
}) => {
  const session = await readSession()
  if (!session) return null

  const { object: named, type } = await searchParams
  const object = named ?? (type ? HUBSPOT_TYPES[type] : undefined)
  const ctx = contextFrom(session)

  // From the registry rather than a list here, so an object an admin invented
  // is in the object picker the moment it exists.
  const registry = await getRegistry(ctx)
  const objects = registry.objects.map((entry) => ({ key: entry.key, label: entry.namePlural }))
  const current = objects.some((entry) => entry.key === object) ? object! : 'contact'

  const target = objectOrThrow(registry, current)
  // The denominator of the fill rate. One count against the object's own rows,
  // beside a per-property numerator the nightly job already worked out.
  const [fields, deleted, [counted]] = await Promise.all([
    listFields(ctx, current),
    sessionIsAdmin(session) ? listDeletedFields(ctx) : Promise.resolve([]),
    withAccount(ctx, (tx) =>
      tx.execute<{ n: number }>(
        sql`select count(*)::int as n from ${tableFor(target)}
             where ${rowsOf(target)} and ${sql.raw(`"${target.key}"."deleted_at"`)} is null`,
      ),
    ),
  ])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Properties"
        lead="Properties are used to collect and store information about your records. For example, a contact might have properties like First Name or Lifecycle Stage."
        why={
          <p>
            A field added here shows up in the record editor, the filters, the import mapper, CSV
            export and the agent tools straight away, because all of them read this list rather
            than their own.
          </p>
        }
      />

      <PropertyList
        object={current}
        objects={objects}
        rows={fields}
        deleted={deleted.filter((field) => field.objectKey === current)}
        recordCount={Number(counted?.n ?? 0)}
        filterFields={toFilterFields(target)}
        hub="account"
        canWrite={sessionIsAdmin(session)}
      />
    </div>
  )
}

export default PropertiesPage
