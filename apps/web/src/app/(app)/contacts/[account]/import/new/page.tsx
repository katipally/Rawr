import {
  canWrite,
  dedupeKeyOf,
  getRegistry,
  importShapeFor,
  requiredColumnKeys,
  type ImportKind,
} from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import { redirect } from 'next/navigation'
import { LinkButton } from '~/components/link-button.tsx'
import { importsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import type { ImportKindOption } from '../import-kind-field.tsx'
import { NewImport } from '../import-uploader.tsx'
import { SHAPE_LABEL } from '../shapes.ts'

/** HubSpot's Import files wizard, its Type and Upload steps. The run it starts
 *  carries on at /import/<id>, under the same frame, from Upload onwards. */
const NewImportPage = async ({ params }: { params: Promise<{ account: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const ctx = contextFrom(session)
  if (!canWrite(ctx, 'contact')) {
    return (
      <EmptyState
        title="Importing is not something your role does"
        description="You need contacts access to create records, so you cannot import them either."
        action={<LinkButton href={importsPath(account)}>Back to imports</LinkButton>}
      />
    )
  }
  // From the registry rather than a list of three: an object an admin invented
  // has records, and a migration arrives as a file of them like anything else.
  const registry = await getRegistry(ctx)

  /** Built here rather than in the picker: the shapes and the match column are
   *  the import layer's answer, and a sentence typed into a component is one
   *  that goes stale the first time a shape gains a column. */
  const kindOptions: ImportKindOption[] = [
    ...registry.objects.map((entry) => {
      const key = dedupeKeyOf('records', entry)
      return {
        value: entry.key,
        label: entry.namePlural,
        what: `Every column is a field on a ${entry.nameSingular.toLowerCase()}. Rows are matched on ${
          entry.byKey.get(key)?.label ?? key
        }, so importing the same file again updates rather than creating a second copy.`,
        columns: [],
        required: [],
      }
    }),
    ...(Object.keys(SHAPE_LABEL) as Exclude<ImportKind, 'records'>[]).map((kind) => {
      const shape = importShapeFor(kind)
      const labelOf = (key: string) => shape?.byKey.get(key)?.label ?? key
      return {
        value: kind,
        label: SHAPE_LABEL[kind].label,
        what: SHAPE_LABEL[kind].what,
        columns: shape?.fields.map((entry) => entry.label) ?? [],
        required: requiredColumnKeys(kind).map(labelOf),
      }
    }),
  ]

  return <NewImport account={account} kinds={kindOptions} />
}

export default NewImportPage
