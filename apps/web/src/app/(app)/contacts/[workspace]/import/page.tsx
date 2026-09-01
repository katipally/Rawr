import { canWrite, listImportRuns } from '@rawr/db'
import { Button, EmptyState, Field, Select } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatDateTime } from '~/components/crm/value.tsx'
import { importsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { MAX_BYTES, MAX_ROWS } from '~/server/spreadsheet.ts'

const ImportPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ error?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')

  const { workspace } = await params
  const { error } = await searchParams
  const ctx = contextFrom(session)
  const runs = await listImportRuns(ctx)
  const allowed = canWrite(session.role, 'contact')

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-lg font-medium">Import</h1>

      {error ? (
        <p role="alert" className="rounded-hs border border-error bg-error-subtle px-3 py-2 text-error">
          {error}
        </p>
      ) : null}

      {allowed ? (
        <form
          action={`${importsPath(workspace)}/upload`}
          method="post"
          encType="multipart/form-data"
          className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-3"
        >
          <Field id="import-object" label="What is in the file">
            <Select id="import-object" name="object" defaultValue="contact">
              <option value="contact">Contacts</option>
              <option value="company">Companies</option>
              <option value="deal">Deals</option>
            </Select>
          </Field>

          <Field
            id="import-file"
            label="File"
            hint={`CSV or XLSX, up to ${MAX_BYTES / 1024 / 1024}MB and ${MAX_ROWS.toLocaleString()} rows. Nothing is written until you have seen the preview.`}
          >
            <input
              id="import-file"
              name="file"
              type="file"
              required
              accept=".csv,.txt,.xlsx"
              className="w-full min-w-0 rounded-hs border border-line bg-fill px-3 py-1.5"
            />
          </Field>

          <div>
            <Button type="submit" variant="primary">
              Upload and map columns
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-secondary">
          Your role ({session.role}) cannot create records, so it cannot import them either.
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Recent imports</h2>
        {runs.length === 0 ? (
          <EmptyState
            title="Nothing has been imported yet"
            description="An import runs on the server, so you can close this tab and come back to it."
          />
        ) : (
          <ul className="flex flex-col rounded-panel border border-line bg-surface">
            {runs.map((run) => (
              <li key={run.id} className="border-b border-divider px-3 py-2 last:border-0">
                <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <Link href={importsPath(workspace, run.id)} className="min-w-0 break-words font-medium">
                    {run.filename}
                  </Link>
                  <span className="text-secondary">{formatDateTime(run.createdAt)}</span>
                </p>
                <p className="text-secondary tabular-nums">
                  {run.objectType} · {run.state} · {run.processedRows.toLocaleString()} of{' '}
                  {run.totalRows.toLocaleString()} rows · {run.created} created, {run.updated} updated,{' '}
                  {run.skipped} skipped, {run.errored} with a problem
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

export default ImportPage
