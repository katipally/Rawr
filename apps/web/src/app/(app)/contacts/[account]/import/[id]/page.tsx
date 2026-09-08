import {
  getRegistry,
  importShapeFor,
  objectOrThrow,
  readImportRun,
  schema,
  suggestMapping,
  withAccount,
  type Mapping,
} from '@rawr/db'
import { EmptyState } from '@rawr/ui'
import { desc, eq, and, ne } from 'drizzle-orm'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ImportWizard } from '~/components/crm/import-wizard.tsx'
import { importsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'

const SAMPLE_ROWS = 500

const ImportRunPage = async ({ params }: { params: Promise<{ account: string; id: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account, id } = await params
  const ctx = contextFrom(session)
  const run = await readImportRun(ctx, id)

  if (!run) {
    return (
      <EmptyState
        title="That import is not here"
        description="It was never started in this account, or the link is wrong."
        action={<Link href={importsPath(account)}>Back to imports</Link>}
      />
    )
  }

  // The rows live on the run until it finishes, which is what makes a killed run
  // resumable without a re-upload.
  const [detail] = await withAccount(ctx, (tx) =>
    tx
      .select({
        rows: schema.importRun.rows,
        mapping: schema.importRun.mapping,
        fileSignature: schema.importRun.fileSignature,
      })
      .from(schema.importRun)
      .where(eq(schema.importRun.id, id))
      .limit(1),
  )

  const rows = (detail?.rows as Record<string, string>[] | null) ?? []
  // From the run, not from a row's key order: jsonb sorts its keys, and a mapper
  // that reorders a person's columns is a mapper they cannot trust.
  const headers = run.headers.length > 0 ? run.headers : Object.keys(rows[0] ?? {})
  // Every kind but `records` is mapped against a fixed shape rather than the
  // account's registry: those columns say which record something belongs to,
  // not what to write on one.
  const object = importShapeFor(run.importKind) ?? objectOrThrow(await getRegistry(ctx), run.objectType)

  const stored = (detail?.mapping as Mapping | undefined) ?? {}
  const mapping = Object.keys(stored).length > 0 ? stored : suggestMapping(object, headers)

  const [previous] = detail
    ? await withAccount(ctx, (tx) =>
        tx
          .select({ mapping: schema.importRun.mapping })
          .from(schema.importRun)
          .where(
            and(
              eq(schema.importRun.fileSignature, detail.fileSignature),
              eq(schema.importRun.state, 'done'),
              ne(schema.importRun.id, id),
            ),
          )
          .orderBy(desc(schema.importRun.createdAt))
          .limit(1),
      )
    : []

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <p>
        <Link href={importsPath(account)}>Imports</Link>
      </p>

      <ImportWizard
        account={account}
        runId={id}
        object={run.objectType}
        kind={run.importKind}
        source={run.source}
        filename={run.filename}
        headers={headers}
        sampleRows={rows.slice(0, SAMPLE_ROWS)}
        fields={object.fields
          .filter((field) => field.key !== 'created_at')
          .map((field) => ({ key: field.key, label: field.label, isRequired: field.isRequired }))}
        initialMapping={mapping}
        previousMapping={(previous?.mapping as Mapping | undefined) ?? null}
        totalRows={run.totalRows}
        state={run.state}
        processedRows={run.processedRows}
        counts={{
          created: run.created,
          updated: run.updated,
          skipped: run.skipped,
          errored: run.errored,
        }}
        errors={run.errors}
        unmatchedOwners={run.unmatchedOwners}
      />
    </div>
  )
}

export default ImportRunPage
