import {
  canWrite,
  dedupeKeyOf,
  getRegistry,
  importShapeFor,
  listImportRuns,
  requiredColumnKeys,
  type ImportKind,
} from '@rawr/db'
import { Alert, Badge, Button, EmptyState, Field, PageHeader, Select } from '@rawr/ui'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { formatDateTime, formatNumber } from '~/components/crm/value.tsx'
import { availableAppsPath, importsPath } from '~/lib/links.ts'
import { contextFrom, readSession } from '~/server/session.ts'
import { MAX_BYTES, MAX_ROWS } from '~/server/spreadsheet.ts'
import { ClearError } from './clear-error.tsx'
import { ImportKindField, type ImportKindOption } from './import-kind-field.tsx'

/** What each of the five shape files is for, in the picker's own words. The
 *  columns beside them are read off the shapes themselves. */
const SHAPE_LABEL: Record<Exclude<ImportKind, 'records'>, { label: string; what: string }> = {
  activities: {
    label: 'Notes and logged emails',
    what: 'Timeline entries against records that already exist. Nothing here creates a contact.',
  },
  properties: {
    label: 'Property definitions',
    what: 'The fields records go into. Import this first: a column cannot arrive before the field it fills.',
  },
  associations: {
    label: 'Deal contacts and companies',
    what: 'Who is on which deal. A record export carries a contact’s company and nothing else.',
  },
  lists: {
    label: 'List memberships',
    what: 'One row per person per list. Each list arrives as a snapshot of the people the file names.',
  },
  submissions: {
    label: 'Form submissions',
    what: 'Submission history, so the forms report is not empty and a timeline does not start at the cutover.',
  },
}

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
  // From the registry rather than a list of three: an object an admin invented
  // has records, and a migration arrives as a file of them like anything else.
  const registry = await getRegistry(ctx)
  const allowed = canWrite(contextFrom(session), 'contact')

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

      {error ? (
        <>
          <Alert>{error}</Alert>
          <ClearError />
        </>
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
          <ImportKindField options={kindOptions} />

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
            hint={`CSV or XLSX, up to ${MAX_BYTES / 1024 / 1024}MB and ${formatNumber(MAX_ROWS)} rows. Nothing is written until you have seen the preview.`}
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
                      {formatNumber(run.processedRows)} / {formatNumber(run.totalRows)}
                    </td>
                    <td className="px-6 tabular-nums">{formatNumber(run.created)}</td>
                    <td className="px-6 tabular-nums">{formatNumber(run.updated)}</td>
                    <td className="px-6 tabular-nums">{formatNumber(run.skipped)}</td>
                    <td className="px-6 tabular-nums">{formatNumber(run.errored)}</td>
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
