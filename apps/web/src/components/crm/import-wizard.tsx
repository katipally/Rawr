'use client'

import { Alert, Button, buttonClass, Select, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { ImportKind, ObjectKey } from '@rawr/db'
import { api, errorMessage } from '~/lib/rpc.ts'

/** The loop runs in this tab, so it is bounded. Reaching it is reported, never
 *  dressed up as a finished import. */
const MAX_CHUNKS = 10_000

export type MappableField = { key: string; label: string; isRequired: boolean }

export type ImportWizardProps = {
  account: string
  runId: string
  object: ObjectKey
  /** Records fill columns; activities land on the timeline of the record they
   *  name; the other four carry the shape around the records. */
  kind: ImportKind
  /** Which export the file came out of, so the dry run reads it the way the run
   *  will. Without it a preview built its own preset and the run used another. */
  source: string | null
  filename: string
  headers: string[]
  sampleRows: Record<string, string>[]
  fields: MappableField[]
  initialMapping: Record<string, string | null>
  previousMapping: Record<string, string | null> | null
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
  samples: { create: Record<string, string>[]; update: Record<string, string>[]; error: { row: number; reason: string; values: Record<string, string> }[] }
}

export const ImportWizard = ({
  account,
  runId,
  object,
  kind,
  source,
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
  const [mapping, setMapping] = useState(initialMapping)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(processedRows)
  const [running, setRunning] = useState(false)
  /** Set to stop the chunk loop between calls: by the Stop button, and by leaving
   *  the page. Without it the loop kept sending chunks after this component was
   *  gone, and its toast landed on whatever screen the person had moved to. */
  const stopped = useRef(false)

  useEffect(
    () => () => {
      stopped.current = true
    },
    [],
  )

  const finished = state === 'done'
  /** Over, one way or another. A cancelled or failed run keeps its counts and
   *  its error list; what it must not keep is a Resume button. */
  const stoppedForGood = state === 'cancelled' || state === 'failed'

  // Two headers on one field is blocked in the mapper, before the dry run.
  const duplicates = Object.entries(mapping).reduce<Record<string, string[]>>((acc, [header, key]) => {
    if (!key) return acc
    acc[key] = [...(acc[key] ?? []), header]
    return acc
  }, {})
  const clashes = Object.entries(duplicates).filter(([, list]) => list.length > 1)

  const runDryRun = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.crm.imports.setMapping.mutate({ id: runId, mapping })
      const result = await api.crm.imports.dryRun.query({
        object,
        kind,
        source,
        mapping,
        rows: sampleRows,
      })
      setPreview(result as Preview)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  /** One chunk per call, so the run survives a closed tab: the server holds the
   *  cursor and reopening this page picks it back up with Resume. A8.
   *
   *  The tab still has to stay open for the loop itself, so a run that stops for
   *  any reason says so plainly rather than claiming it finished. */
  const run = async () => {
    stopped.current = false
    setRunning(true)
    setError(null)
    try {
      let done = false
      let chunks = 0
      while (!done && !stopped.current && chunks < MAX_CHUNKS) {
        const result = await api.crm.imports.runChunk.mutate({ id: runId })
        setProgress(result.processed)
        done = result.done
        chunks += 1
      }
      if (done) toast('success', 'Import finished.')
      else if (stopped.current) toast('info', 'Import paused. Resume picks up where it stopped.')
      else {
        toast(
          'info',
          `Stopped after ${MAX_CHUNKS.toLocaleString()} chunks so this tab is not held open indefinitely. Resume continues from here.`,
        )
      }
      router.refresh()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setRunning(false)
    }
  }

  if (finished || stoppedForGood || state === 'running') {
    const pct = totalRows === 0 ? 100 : Math.round((progress / totalRows) * 100)
    const accounted = counts.created + counts.updated + counts.skipped + counts.errored
    return (
      <div className="flex flex-col gap-3">
        <h2 className="font-medium">{filename}</h2>
        <p className="tabular-nums">
          {progress.toLocaleString()} of {totalRows.toLocaleString()} rows ({pct}%)
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
            ['Created', counts.created],
            ['Updated', counts.updated],
            ['Skipped', counts.skipped],
            ['With a problem', counts.errored],
          ].map(([label, value]) => (
            <div key={String(label)}>
              <dt className="text-small text-secondary">{label}</dt>
              <dd className="text-lg">{Number(value).toLocaleString()}</dd>
            </div>
          ))}
        </dl>

        {/* Rows in against rows out. A migration nobody can check is a migration
            nobody will trust, and four counters that happen not to add up is the
            first thing worth knowing. */}
        {finished && accounted !== totalRows ? (
          <Alert tone="warning">
            {totalRows.toLocaleString()} rows went in and {accounted.toLocaleString()} are accounted
            for. The {Math.abs(totalRows - accounted).toLocaleString()} in between are rows where
            every mapped column was empty.
          </Alert>
        ) : null}

        {unmatchedOwners.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="font-medium">Owners nobody here matches ({unmatchedOwners.length})</h3>
            <p className="text-secondary">
              Those records came in unassigned. Invite these people under Settings, Members and run
              the same file again to fill the owner in.
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {unmatchedOwners.map((owner) => (
                <li key={owner} className="rounded-hs border border-line bg-fill px-2 py-0.5">
                  {owner}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {stoppedForGood ? (
          <p className="text-secondary">
            {state === 'cancelled'
              ? 'Stopped. Everything imported before it stopped is in the CRM; upload the file again to bring in the rest.'
              : 'This import could not go on. The reason is in the errors below; fix it and upload the file again.'}
          </p>
        ) : null}

        {!finished && !stoppedForGood ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={running} onClick={() => void run()}>
              {running ? 'Importing' : 'Resume the import'}
            </Button>
            {running ? (
              <Button
                onClick={() => {
                  // Both halves: stop asking for chunks, and tell the server the
                  // run is over. Without the second the run stayed 'running'
                  // for ever and the screen kept implying it was still going.
                  stopped.current = true
                  void api.crm.imports.cancel.mutate({ id: runId }).then(
                    () => router.refresh(),
                    (cause: unknown) => setError(errorMessage(cause)),
                  )
                }}
              >
                Stop this import
              </Button>
            ) : null}
          </div>
        ) : null}

        {errors.length > 0 ? (
          <section className="flex flex-col gap-2">
            <h3 className="font-medium">Rows that need a person ({counts.errored.toLocaleString()})</h3>
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
                Showing the first 25. The CSV has all {counts.errored.toLocaleString()}.
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
          {totalRows.toLocaleString()} rows, {headers.length} columns
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
            const target = mapping[header] ?? ''
            const clashing = target !== '' && (duplicates[target]?.length ?? 0) > 1
            return (
              <tr key={header} className="border-b border-divider last:border-0">
                <td className="px-3 py-1.5 align-middle break-words">{header}</td>
                <td className="px-3 py-1.5 align-middle text-secondary break-words">
                  {sampleRows[0]?.[header] || <span className="text-secondary">empty</span>}
                </td>
                <td className="px-3 py-1.5 align-middle">
                  <Select
                    aria-label={`Field for ${header}`}
                    aria-invalid={clashing}
                    value={target}
                    onChange={(event) =>
                      setMapping((current) => ({ ...current, [header]: event.target.value || null }))
                    }
                  >
                    <option value="">Do not import</option>
                    {fields.map((field) => (
                      <option key={field.key} value={field.key}>
                        {field.label}
                        {field.isRequired ? ' (required)' : ''}
                      </option>
                    ))}
                  </Select>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

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
          <Button variant="primary" busy={running} onClick={() => void run()}>
            Import {totalRows.toLocaleString()} rows
          </Button>
        ) : null}
        {running ? (
          <Button onClick={() => (stopped.current = true)}>Stop after this chunk</Button>
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
                <dd className="text-lg">{Number(value).toLocaleString()}</dd>
              </div>
            ))}
          </dl>

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
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
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
