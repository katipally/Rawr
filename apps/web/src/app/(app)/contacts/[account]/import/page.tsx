import { canWrite, listImportRuns } from '@rawr/db'
import { Alert, Badge, Button, EmptyState, Field, PageHeader, Select } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatDateTime } from '~/components/crm/value.tsx'
import { availableAppsPath, importsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { MAX_BYTES, MAX_ROWS } from '~/server/spreadsheet.ts'

const ImportPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ account: string }>
  searchParams: Promise<{ error?: string }>
}) => {
  const session = await readSession()
  if (!session) redirect('/sign-in')
  const zone = session.timezone

  const { account } = await params
  const { error } = await searchParams
  const ctx = contextFrom(session)
  const runs = await listImportRuns(ctx)
  const allowed = canWrite(contextFrom(session), 'contact')

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Data integration"
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

      {error ? (
        <Alert>
          {error}
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
      {allowed ? (
        <form
          action={`${importsPath(account)}/upload`}
          method="post"
          encType="multipart/form-data"
          className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-6 shadow-panel"
        >
          <h2 className="text-base font-semibold">Import a file</h2>
          <p className="text-secondary">One-time import from a file, directly into the CRM.</p>
          <Field id="import-object" label="What is in the file">
            <Select id="import-object" name="object" defaultValue="contact">
              <option value="contact">Contacts</option>
              <option value="company">Companies</option>
              <option value="deal">Deals</option>
              <option value="activities">Notes and logged emails</option>
              <option value="properties">Property definitions</option>
              <option value="associations">Deal contacts and companies</option>
              <option value="lists">List memberships</option>
              <option value="submissions">Form submissions</option>
            </Select>
          </Field>

          <Field
            id="import-source"
            label="Where it came from"
            hint="A HubSpot export is mapped for you: its column names are matched to Rawr's fields, and the columns that mean nothing here are dismissed. Importing the same export twice changes nothing."
          >
            <Select id="import-source" name="source" defaultValue="">
              <option value="">A file I put together</option>
              <option value="hubspot">A HubSpot export</option>
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
        <p className="rounded-panel border border-line bg-surface p-6 text-secondary shadow-panel">
          You need contacts access to create records, so you cannot import them either.
        </p>
      )}
        <section className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-6 shadow-panel">
          <h2 className="text-base font-semibold">Sync from apps</h2>
          <p className="text-secondary">Keep data flowing between the CRM and the tools already connected to it: mail, enrichment, calendars and the rest.</p>
          <div className="mt-auto">
            <Link
              href={availableAppsPath()}
              className="inline-flex h-control items-center rounded-pill border border-line-strong px-4 text-small font-light text-body no-underline hover:bg-fill"
            >
              Connect an app
            </Link>
          </div>
        </section>
      </div>

      <section className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-6 shadow-panel">
        <h2 className="text-base font-semibold">Monitor your imports</h2>
        {runs.length === 0 ? (
          <EmptyState
            title="Nothing has been imported yet"
            description="An import runs on the server, so you can close this tab and come back to it."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] border-t border-line text-left">
              <thead>
                <tr className="text-secondary">
                  {['Import name', 'Object', 'State', 'Rows', 'New records', 'Updated', 'Skipped', 'Errors', 'Created'].map((label) => (
                    <th key={label} scope="col" className="h-row border-b border-line px-6 font-normal">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-line hover:bg-fill">
                    <td className="h-row px-6 py-0.5">
                      <Link href={importsPath(account, run.id)} className="font-semibold">
                        {run.filename}
                      </Link>
                    </td>
                    <td className="px-6">{run.objectType}</td>
                    <td className="px-6">
                      <Badge tone={run.state === 'done' ? 'ok' : run.state === 'failed' ? 'error' : 'neutral'}>{run.state}</Badge>
                    </td>
                    <td className="px-6 tabular-nums">
                      {run.processedRows.toLocaleString()} / {run.totalRows.toLocaleString()}
                    </td>
                    <td className="px-6 tabular-nums">{run.created.toLocaleString()}</td>
                    <td className="px-6 tabular-nums">{run.updated.toLocaleString()}</td>
                    <td className="px-6 tabular-nums">{run.skipped.toLocaleString()}</td>
                    <td className="px-6 tabular-nums">{run.errored.toLocaleString()}</td>
                    <td className="px-6 whitespace-nowrap text-secondary">{formatDateTime(run.createdAt, zone)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

export default ImportPage
