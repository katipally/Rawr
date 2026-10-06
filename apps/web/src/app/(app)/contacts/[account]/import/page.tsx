import { canWrite, getRegistry, listImportRuns } from '@rawr/db'
import { PageHeader } from '@rawr/ui'
import { LinkButton } from '~/components/link-button.tsx'
import { redirect } from 'next/navigation'
import { stepPill } from '~/components/crm/import-frame.tsx'
import { appsPath, availableAppsPath, importsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { ImportHistory } from './import-history.tsx'
import { UnfinishedUploads } from './import-uploader.tsx'
import { SHAPE_LABEL } from './shapes.ts'

const ImportPage = async ({ params }: { params: Promise<{ account: string }> }) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { account } = await params
  const ctx = contextFrom(session)
  const runs = await listImportRuns(ctx)
  const registry = await getRegistry(ctx)
  const allowed = canWrite(ctx, 'contact')
  const whatOf = (run: (typeof runs)[number]): string =>
    run.importKind === 'records'
      ? (registry.objects.find((entry) => entry.key === run.objectType)?.namePlural ?? run.objectType)
      : SHAPE_LABEL[run.importKind].label

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Import"
        lead="Records, and the shape around them."
        why={
          <>
            <p>
              Records fill columns on a contact, company or deal. The other four files carry what a
              record export leaves behind: the properties records go into, the people on a deal, who
              is in which list, and what a form was told.
            </p>
            <p>
              Order matters for a migration. Properties first, because columns cannot arrive before
              the fields they go in; then records; then everything that points at a record.
            </p>
          </>
        }
      />

      {allowed ? <UnfinishedUploads account={account} /> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-6 shadow-panel">
          <h2 className="text-base font-semibold">Import a file</h2>
          <p className="text-secondary">One-time import from a file, directly into the CRM.</p>
          <div className="mt-auto">
            {allowed ? (
              <LinkButton href={importsPath(account, 'new')} className={stepPill}>
                Import data
              </LinkButton>
            ) : (
              <p className="text-secondary">
                You need contacts access to create records, so you cannot import them either.
              </p>
            )}
          </div>
        </section>
        <section className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-6 shadow-panel">
          <h2 className="text-base font-semibold">Sync from apps</h2>
          <p className="text-secondary">Keep data flowing between the CRM and the tools already connected to it: mail, enrichment, calendars and the rest.</p>
          <div className="mt-auto">
            <LinkButton href={availableAppsPath()} className={stepPill}>Connect an app</LinkButton>
          </div>
        </section>
      </div>

      <section className="flex min-w-0 flex-col gap-4 rounded-panel border border-line bg-surface p-6 shadow-panel">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-medium">Monitor your imports</h2>
          <LinkButton href={appsPath()}>Connected apps</LinkButton>
        </div>
        <ImportHistory
          account={account}
          runs={runs.map((run) => ({
            id: run.id,
            filename: run.filename,
            what: whatOf(run),
            state: run.state,
            uploadedBytes: run.uploadedBytes,
            fileBytes: run.fileBytes,
            totalRows: run.totalRows,
            processedRows: run.processedRows,
            created: run.created,
            updated: run.updated,
            skipped: run.skipped,
            errored: run.errored,
            createdByName: run.createdByName,
            createdAt: run.createdAt.toISOString(),
          }))}
        />
      </section>
    </div>
  )
}

export default ImportPage
