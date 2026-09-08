import { getRegistry, listDeletedFields, listFields } from '@rawr/db'
import { PageHeader, cn } from '@rawr/ui'
import Link from 'next/link'
import { propertiesPath } from '~/lib/links.ts'
import { contextFrom, readSession, sessionIsAdmin } from '~/server/session.ts'
import { PropertyList } from './property-list.tsx'

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
  const ctx = contextFrom(session)

  // From the registry rather than a list here, so an object an admin invented
  // gets its own tab the moment it exists.
  const registry = await getRegistry(ctx)
  const objects = registry.objects.map((entry) => ({ key: entry.key, label: entry.namePlural }))
  const current = objects.some((entry) => entry.key === object) ? object! : 'contact'

  const [fields, deleted] = await Promise.all([
    listFields(ctx, current),
    sessionIsAdmin(session) ? listDeletedFields(ctx) : Promise.resolve([]),
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
        {objects.map((entry) => (
          <Link
            key={entry.key}
            href={propertiesPath(entry.key)}
            aria-current={entry.key === current ? 'page' : undefined}
            className={cn(
              'inline-flex h-control items-center rounded-pill border border-line-strong px-4 text-small font-light text-body no-underline',
              entry.key === current
                ? 'bg-fill-hover'
                : 'bg-surface hover:bg-fill',
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
        hub="account" canWrite={sessionIsAdmin(session)}
      />
    </div>
  )
}

export default PropertiesPage
