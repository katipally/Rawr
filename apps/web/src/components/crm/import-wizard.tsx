'use client'

import { FIELD_TYPES, isNewProperty, type FieldType, type Mapping, type NewProperty } from '@rawr/db/registry'
import { Alert, Button, buttonClass, Select, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { formatNumber } from './value.tsx'

/** How often a running import is asked where it got to. Short enough that the bar
 *  moves, long enough that a 90,000-row run is not thousands of requests. */
const POLL_MS = 2_000

/** The value the "Goes into" select carries for a column that has no field yet.
 *  Punctuation keeps it out of the field-key namespace, and unlike a NUL it
 *  survives being written into an HTML attribute and parsed back. */
const CREATE = '!create'

export type MappableField = { key: string; label: string; isRequired: boolean }

export type ImportWizardProps = {
  account: string
  runId: string
  filename: string
  headers: string[]
  sampleRows: Record<string, string>[]
  fields: MappableField[]
  initialMapping: Mapping
  previousMapping: Mapping | null
  totalRows: number
  state: string
  processedRows: number
  counts: { created: number; updated: number; skipped: number; errored: number }
  errors: { row: number; reason: string; values: Record<string, string> }[]
  /** Owner names in the file that match nobody here. Those rows landed
   *  unassigned rather than failing, so this is what a migration reconciles. */
  unmatchedOwners: string[]
}

type Preview = {
  willCreate: number
  willUpdate: number
  willSkip: number
  willError: number
  checked: number
  total: number
  newProperties: { header: string; label: string; type: string; options?: string[] }[]
  samples: { create: Record<string, string>[]; update: Record<string, string>[]; error: { row: number; reason: string; values: Record<string, string> }[] }
}

export const ImportWizard = ({
  account,
  runId,
  filename,
  headers,
  sampleRows,
  fields,
  initialMapping,
  previousMapping,
  totalRows,
  state,
  processedRows,
  counts,
  errors,
  unmatchedOwners,
}: ImportWizardProps) => {
  const router = useRouter()
  const toast = useToast()
  const [mapping, setMapping] = useState<Mapping>(initialMapping)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Everything the run changes while nobody is editing it. The server owns the
   *  run now, so the page reads it rather than driving it. */
  const [live, setLive] = useState({ state, counts, processed: processedRows, unmatchedOwners })

  const finished = live.state === 'done'
  /** Over, one way or another. A cancelled or failed run keeps its counts and
   *  its error list; what it must not keep is a Resume button. */
  const stoppedForGood = live.state === 'cancelled' || live.state === 'failed'

  /** The tab watches; the worker works. Closing this page stops nothing, and
   *  reopening it picks the run up wherever the worker has got to. A8. */
  useEffect(() => {
    if (live.state !== 'running') return
    let dropped = false
    const ask = async () => {
      try {
        const run = await api.crm.imports.read.query({ id: runId })
        if (dropped || !run) return
        setLive({
          state: run.state,
          counts: { created: run.created, updated: run.updated, skipped: run.skipped, errored: run.errored },
          processed: run.processedRows,
          unmatchedOwners: run.unmatchedOwners,
        })
        if (run.state === 'done') toast('success', 'Import finished.')
        // The error list and the rest of the detail are the server component's;
        // one refresh at the end beats shipping them every two seconds.
        if (run.state !== 'running') router.refresh()
      } catch {
        // A poll that misses is a poll. The next one answers.
      }
    }
    void ask()
    const timer = setInterval(() => void ask(), POLL_MS)
    return () => {
      dropped = true
      clearInterval(timer)
    }
  }, [live.state, runId, router, toast])

  /** What the mapper opened with, so switching a column back to "Create
   *  property" offers the same inferred name and type rather than an empty one. */
  const proposalFor = (header: string): NewProperty | null => {
    const initial = initialMapping[header]
    return isNewProperty(initial) ? initial : null
  }

  const patchProposal = (header: string, patch: Partial<NewProperty>) =>
    setMapping((current) => {
      const target = current[header]
      return isNewProperty(target) ? { ...current, [header]: { ...target, ...patch } } : current
    })

  // Two headers on one field is blocked in the mapper, before the dry run. A
  // proposed property takes its key the moment the run starts, so it counts.
  const duplicates = Object.entries(mapping).reduce<Record<string, string[]>>((acc, [header, target]) => {
    if (!target) return acc
    const key = isNewProperty(target) ? target.key : target
    acc[key] = [...(acc[key] ?? []), header]
    return acc
  }, {})
  const clashes = Object.entries(duplicates).filter(([, list]) => list.length > 1)

  const runDryRun = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.crm.imports.setMapping.mutate({ id: runId, mapping })
      setPreview((await api.crm.imports.dryRun.mutate({ id: runId })) as Preview)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  /** One click, then the worker. It marks the run running and returns; the chunks
   *  are taken by the job that polls for them, which is what lets the person close
   *  the tab. A8. */
  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.crm.imports.start.mutate({ id: runId })
      setLive((current) => ({ ...current, state: 'running' }))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  const running = live.state === 'running'

  if (finished || stoppedForGood || running) {
    const pct = totalRows === 0 ? 100 : Math.round((live.processed / totalRows) * 100)
    const accounted =
      live.counts.created + live.counts.updated + live.counts.skipped + live.counts.errored
    return (
      <div className="flex flex-col gap-3">
        <h2 className="font-medium">{filename}</h2>
        <p className="tabular-nums">
          {formatNumber(live.processed)} of {formatNumber(totalRows)} rows ({pct}%)
        </p>
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-2 w-full overflow-hidden rounded-hs bg-fill"
        >
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 tabular-nums">
          {[
            ['Created', live.counts.created],
            ['Updated', live.counts.updated],
            ['Skipped', live.counts.skipped],
            ['With a problem', live.counts.errored],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <dt className="text-small text-secondary">{label}</dt>
              <dd className="text-lg">{formatNumber(Number(value))}</dd>
            </div>
          ))}
        </dl>

        {/* Rows in against rows out. A migration nobody can check is a migration
            nobody will trust, and four counters that happen not to add up is the
            first thing worth knowing. */}
        {finished && accounted !== totalRows ? (
          <Alert tone="warning">
            {formatNumber(totalRows)} rows went in and {formatNumber(accounted)} are accounted
            for. The {formatNumber(Math.abs(totalRows - accounted))} in between are rows where
            every mapped column was empty.
          </Alert>
        ) : null}

        {live.unmatchedOwners.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="font-medium">Owners nobody here matches ({live.unmatchedOwners.length})</h3>
            <p className="text-secondary">
              Those records came in unassigned. Invite these people under Settings, Members and run
              the same file again to fill the owner in.
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {live.unmatchedOwners.map((owner) => (
                <li key={owner} className="rounded-hs border border-line bg-fill px-2 py-0.5">
                  {owner}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {stoppedForGood ? (
          <p className="text-secondary">
            {live.state === 'cancelled'
              ? 'Stopped. Everything imported before it stopped is in the CRM; upload the file again to bring in the rest.'
              : 'This import could not go on. The reason is in the errors below; fix it and upload the file again.'}
          </p>
        ) : null}

        {!finished && !stoppedForGood ? (
          <div className="flex flex-wrap gap-2">
            {running ? (
              <Button
                onClick={() => {
                  void api.crm.imports.cancel.mutate({ id: runId }).then(
                    () => setLive((current) => ({ ...current, state: 'cancelled' })),
                    (cause: unknown) => setError(errorMessage(cause)),
                  )
                }}
              >
                Stop this import
              </Button>
            ) : (
              <Button variant="primary" busy={busy} onClick={() => void start()}>
                Resume the import
              </Button>
            )}
          </div>
        ) : null}

        {errors.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="font-medium">Rows that need a person ({formatNumber(live.counts.errored)})</h3>
            <p className="text-secondary">
              Everything else was imported. Fix these rows and upload just them again.
            </p>
            {/* Styled as a button rather than wrapping one: a <button> inside an
                <a> is nested interactive content assistive technology cannot resolve. */}
            <a
              href={`/contacts/${account}/import/${runId}/errors`}
              download
              className={buttonClass('secondary', 'w-fit no-underline')}
            >
              Download the failed rows as CSV
            </a>
            <ul className="flex flex-col rounded-panel border border-line bg-surface">
              {errors.slice(0, 25).map((row) => (
                <li key={`${row.row}-${row.reason}`} className="border-b border-divider px-3 py-1.5 last:border-0">
                  <span className="text-secondary tabular-nums">Row {row.row}: </span>
                  {row.reason}
                </li>
              ))}
            </ul>
            {errors.length > 25 ? (
              <p className="text-secondary">
                Showing the first 25. The CSV has all {formatNumber(live.counts.errored)}.
              </p>
            ) : null}
          </section>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-medium">{filename}</h2>
        <p className="text-secondary tabular-nums">
          {formatNumber(totalRows)} rows, {headers.length} columns
        </p>
      </div>

      {previousMapping ? (
        <div className="flex flex-wrap items-center gap-2 rounded-hs border border-line bg-fill px-3 py-2">
          <span className="min-w-0 flex-1">
            A file with these columns was imported before. Use the mapping it used?
          </span>
          <Button onClick={() => setMapping(previousMapping)}>Use it</Button>
        </div>
      ) : null}

      <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">Map each column in the file to a field</caption>
        <thead>
          <tr className="bg-fill">
            <th scope="col" className="border-b border-line px-3 py-2 text-small font-medium text-secondary">
              Column in the file
            </th>
            <th scope="col" className="border-b border-line px-3 py-2 text-small font-medium text-secondary">
              First value
            </th>
            <th scope="col" className="border-b border-line px-3 py-2 text-small font-medium text-secondary">
              Goes into
            </th>
          </tr>
        </thead>
        <tbody>
          {headers.map((header) => {
            const target = mapping[header] ?? null
            const proposal = isNewProperty(target) ? target : null
            const mapped = typeof target === 'string' ? target : ''
            const key = proposal ? proposal.key : mapped
            const clashing = key !== '' && (duplicates[key]?.length ?? 0) > 1
            return (
              <tr key={header} className="border-b border-divider last:border-0">
                <td className="px-3 py-1.5 align-middle break-words">{header}</td>
                <td className="px-3 py-1.5 align-middle text-secondary break-words">
                  {sampleRows[0]?.[header] || <span className="text-secondary">empty</span>}
                </td>
                <td className="px-3 py-1.5 align-middle">
                  <div className="flex flex-col gap-1.5">
                    <Select
                      aria-label={`Field for ${header}`}
                      aria-invalid={clashing}
                      value={proposal ? CREATE : mapped}
                      onChange={(event) =>
                        setMapping((current) => ({
                          ...current,
                          [header]:
                            event.target.value === CREATE
                              ? (proposalFor(header) ?? null)
                              : event.target.value || null,
                        }))
                      }
                    >
                      <option value="">Do not import</option>
                      <option value={CREATE}>Create property</option>
                      {fields.map((field) => (
                        <option key={field.key} value={field.key}>
                          {field.label}
                          {field.isRequired ? ' (required)' : ''}
                        </option>
                      ))}
                    </Select>

                    {/* The proposal, editable where it stands. A migration is
                        sixty-eight of these; a modal each is sixty-eight modals. */}
                    {proposal ? (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <TextInput
                          aria-label={`Name of the new property for ${header}`}
                          value={proposal.label}
                          onChange={(event) => patchProposal(header, { label: event.target.value })}
                          className="w-auto min-w-32 flex-1"
                        />
                        <Select
                          aria-label={`Type of the new property for ${header}`}
                          value={proposal.type}
                          onChange={(event) => patchProposal(header, { type: event.target.value as FieldType })}
                          className="w-auto min-w-28 flex-1"
                        >
                          {FIELD_TYPES.map((candidate) => (
                            <option key={candidate} value={candidate}>
                              {candidate}
                            </option>
                          ))}
                        </Select>
                        {proposal.options && proposal.options.length > 0 ? (
                          <span className="text-small text-secondary">
                            {proposal.options.length} choice{proposal.options.length === 1 ? '' : 's'} from the file
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      </div>

      {clashes.length > 0 ? (
        <p role="alert" className="text-error">
          {clashes
            .map(([key, list]) => `${list.join(' and ')} are both mapped to ${fields.find((f) => f.key === key)?.label ?? key}`)
            .join('; ')}
          . Pick one for each.
        </p>
      ) : null}

      {error ? (
        <Alert>
          {error}
        </Alert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button busy={busy} disabled={clashes.length > 0} onClick={() => void runDryRun()}>
          Preview what will happen
        </Button>
        {preview ? (
          <Button variant="primary" busy={busy} onClick={() => void start()}>
            Import {formatNumber(totalRows)} rows
          </Button>
        ) : null}
      </div>

      {preview ? (
        <section className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-3">
          <h3 className="font-medium">Nothing has been written yet</h3>
          <dl className="flex flex-wrap gap-x-6 gap-y-1 tabular-nums">
            {[
              ['Will be created', preview.willCreate],
              ['Will be updated', preview.willUpdate],
              ['Will be skipped', preview.willSkip],
              ['Will be refused', preview.willError],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-small text-secondary">{label}</dt>
                <dd className="text-lg">{formatNumber(Number(value))}</dd>
              </div>
            ))}
          </dl>

          {/* Properties are made once, before the first row, so this is a
              separate promise from the row counts and worth saying on its own. */}
          {preview.newProperties.length > 0 ? (
            <div>
              <p className="font-medium">
                Creates {formatNumber(preview.newProperties.length)} propert
                {preview.newProperties.length === 1 ? 'y' : 'ies'}
              </p>
              <p className="text-secondary">
                Under the group "Imported from HubSpot", before the first row is written. A property
                whose name is already taken is used rather than made again.
              </p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {preview.newProperties.map((property) => (
                  <li
                    key={property.header}
                    className="rounded-hs border border-line bg-fill px-2 py-0.5"
                  >
                    {property.label} <span className="text-secondary">{property.type}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* What the counts are worth. Every row past the checked window is
              counted as a create, which is what a row nobody has looked at
              usually is; a number that says so is worth more than one that does
              not. */}
          <p className="text-secondary">
            {preview.checked >= preview.total
              ? `Every one of the ${formatNumber(preview.total)} rows was checked against the CRM.`
              : `The first ${formatNumber(preview.checked)} of ${formatNumber(preview.total)} rows were checked against the CRM. The other ${formatNumber(preview.total - preview.checked)} are counted as new; any that already exist will be updated instead when the run reaches them.`}
          </p>

          {/* The counts say how many; these say which. A dry run whose only
              detail is the refusals tells you nothing about the 4,000 rows it
              is about to write. */}
          {preview.samples.create.length > 0 ? (
            <SampleRows title="A few that will be created" rows={preview.samples.create} />
          ) : null}
          {preview.samples.update.length > 0 ? (
            <SampleRows title="A few that will be updated" rows={preview.samples.update} />
          ) : null}

          {preview.samples.error.length > 0 ? (
            <div>
              <p className="font-medium">Rows that will be refused</p>
              <ul className="mt-1 flex flex-col gap-1">
                {preview.samples.error.map((row) => (
                  <li key={row.row}>
                    <span className="text-secondary tabular-nums">Row {row.row}: </span>
                    {row.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-secondary">
                A refused row does not stop the run. The rest still import.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )
}

/** A handful of rows exactly as they will be written. Columns come from the rows
 *  themselves rather than the mapping, because a value the mapping drops is
 *  precisely what somebody checking a dry run is looking for. */
const SampleRows = ({ title, rows }: { title: string; rows: Record<string, string>[] }) => {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  return (
    <div>
      <p className="font-medium">{title}</p>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-small">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column} className="border-b border-divider px-2 py-1 text-left font-medium">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              // A sample has no id of its own and two identical rows are exactly
              // what a duplicate-laden file looks like.
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column} className="border-b border-divider px-2 py-1 text-secondary">
                    {row[column] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
