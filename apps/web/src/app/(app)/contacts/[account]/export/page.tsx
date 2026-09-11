import { PageHeader } from '@rawr/ui'
import { getRegistry, listViews, withAccountReads } from '@rawr/db'
import { redirect } from 'next/navigation'
import { ExportPicker, type ExportObject } from '~/components/crm/export-picker.tsx'
import { contextFrom, readSession } from '~/server/session.ts'

/** B8. The CSV route is a download, so it can never render an error a person can
 *  read or a form they can change. This is that form: pick the object, start from
 *  a view or from every field, then hand over to the route. */
const ExportPage = async () => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const ctx = contextFrom(session)
  const objects = await withAccountReads(ctx, async (): Promise<ExportObject[]> => {
    const registry = await getRegistry(ctx)
    const views = await Promise.all(registry.objects.map((object) => listViews(ctx, object.key)))
    return registry.objects.map((object, index) => ({
      key: object.key,
      label: object.namePlural,
      fields: object.fields.map((field) => ({ key: field.key, label: field.label })),
      views: (views[index] ?? []).map((view) => ({
        slug: view.slug,
        name: view.name,
        columns: view.columns,
        filters: JSON.stringify(view.filters),
        sort: view.sorts[0]
          ? `${view.sorts[0].direction === 'desc' ? '-' : ''}${view.sorts[0].key}`
          : null,
      })),
    }))
  })

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Export"
        lead="A CSV of exactly what a view holds: its filters, its columns, its order."
        why={
          <p>
            The file streams straight to your downloads a page at a time, so there is no limit on
            how many rows it holds. Accented names open correctly in Excel, and the same file imports
            back in unchanged.
          </p>
        }
      />
      <ExportPicker account={session.accountSlug} objects={objects} />
    </div>
  )
}

export default ExportPage
