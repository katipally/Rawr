import { isObjectKey, listDeletedFields, listFields, type ObjectKey } from '@rawr/db'
import { PageHeader, cn } from '@rawr/ui'
import Link from 'next/link'
import { propertiesPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { PropertyList } from './property-list.tsx'

const OBJECTS: { key: ObjectKey; label: string }[] = [
  { key: 'contact', label: 'Contacts' },
  { key: 'company', label: 'Companies' },
  { key: 'deal', label: 'Deals' },
]

/** D4's premise, made reachable: marketing adds a property without a deploy.
 *
 *  Every field created here is stored in <object>.custom as jsonb and appears
 *  immediately in the record editor, the filter builder, CSV import and export, and
 *  the MCP tool schema, because all of those read the same registry. */
const PropertiesPage = async ({
  searchParams,
}: {
  searchParams: Promise<{ object?: string }>
}) => {
  const session = await readSession()
  if (!session) return null

  const { object } = await searchParams
  const current: ObjectKey = object && isObjectKey(object) ? object : 'contact'

  const ctx = contextFrom(session)
  const [fields, deleted] = await Promise.all([
    listFields(ctx, current),
    session.role === 'admin' ? listDeletedFields(ctx) : Promise.resolve([]),
  ])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Properties"
        lead="Every field on every record, and the one place they are defined."
        why={
          <p>
            A field added here shows up in the record editor, the filters, the import mapper, CSV
            export and the agent tools straight away, because all of them read this list rather
            than their own.
          </p>
        }
      />

      <nav aria-label="Object" className="flex flex-wrap gap-1">
        {OBJECTS.map((entry) => (
          <Link
            key={entry.key}
            href={propertiesPath(entry.key)}
            aria-current={entry.key === current ? 'page' : undefined}
            className={cn(
              'rounded-hs border px-2 py-1 no-underline',
              entry.key === current
                ? 'border-line-interactive bg-accent-subtle text-link'
                : 'border-line text-secondary',
            )}
          >
            {entry.label}
          </Link>
        ))}
      </nav>

      <PropertyList
        object={current}
        rows={fields}
        deleted={deleted.filter((field) => field.objectKey === current)}
        role={session.role}
      />
    </div>
  )
}

export default PropertiesPage
