'use client'

import { Alert, Button, Field, Select } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { formatNumber } from '~/components/crm/value.tsx'
import { csvReader, sniffDelimiter } from '~/lib/csv.ts'
import { importsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { ImportKindField, type ImportKindOption } from './import-kind-field.tsx'

/** A batch is sent at whichever of these it reaches first: enough rows that a
 *  hundred thousand of them are a hundred requests, few enough characters that a
 *  wide export's batch is still a small request. */
const BATCH_ROWS = 1_000
const BATCH_CHARS = 2_000_000
/** A batch is sent again this many times before the upload gives up. It lands
 *  once however often it is sent, because the server places it by position. */
const ATTEMPTS = 3

/** Cells come back as rich text, formulas, dates and hyperlinks. Each becomes the
 *  string a person would see in the cell, because that is what they mapped. */
const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) {
    // A date cell with no time of day is a date; one with a time keeps it.
    const iso = value.toISOString()
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso
  }
  if (typeof value === 'object') {
    const cell = value as { text?: unknown; result?: unknown; richText?: { text: string }[]; hyperlink?: string }
    if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text).join('')
    if (cell.text !== undefined) return String(cell.text)
    if (cell.result !== undefined) return cellText(cell.result)
    if (cell.hyperlink) return cell.hyperlink
    return ''
  }
  return String(value)
}

/** The file's rows, header first. A CSV is streamed through the reader a chunk at
 *  a time, so its size is not a limit; a workbook is a zip, which has to be opened
 *  whole, and is then walked a row at a time. */
async function* rowsOf(file: File, onRead: (bytes: number) => void): AsyncGenerator<string[]> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.xlsx')) {
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    try {
      await workbook.xlsx.load(await file.arrayBuffer())
    } catch {
      throw new Error('That .xlsx file could not be opened. Re-save it from your spreadsheet app, or export it as CSV.')
    }
    const sheet = workbook.worksheets[0]
    if (!sheet) throw new Error('That workbook has no sheets in it.')
    const rows: string[][] = []
    sheet.eachRow({ includeEmpty: false }, (row) => {
      // values is 1-based with a leading hole, which is why the slice is here.
      rows.push((Array.isArray(row.values) ? row.values.slice(1) : []).map(cellText))
    })
    onRead(file.size)
    yield* rows
    return
  }
  if (!/\.(csv|tsv|txt)$/.test(name)) {
    throw new Error('Upload a .csv or a .xlsx file. Older .xls files need saving as one of those first.')
  }

  const reader = file.stream().getReader()
  const decoder = new TextDecoder()
  let csv: ReturnType<typeof csvReader> | null = null
  let read = 0
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    read += chunk.value.byteLength
    onRead(read)
    const text = decoder.decode(chunk.value, { stream: true })
    csv ??= csvReader(name.endsWith('.tsv') ? '\t' : sniffDelimiter(text))
    yield* csv.push(text)
  }
  csv ??= csvReader()
  yield* csv.push(decoder.decode())
  yield* csv.end()
}

const withRetry = async <T,>(send: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send()
    } catch (cause) {
      if (attempt >= ATTEMPTS) throw cause
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
    }
  }
}

class Stopped extends Error {}

/** Picks the file and sends it. The browser reads it and the server receives its
 *  rows a batch at a time, so no single request carries the file and nothing
 *  between the two can cap how big it is. */
export const ImportUploader = ({ account, kinds }: { account: string; kinds: ImportKindOption[] }) => {
  const router = useRouter()
  const [sending, setSending] = useState<{ percent: number; rows: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stopped = useRef(false)
  const uploading = sending !== null

  // Leaving mid-upload throws away the half that arrived, so the browser asks first.
  useEffect(() => {
    if (!uploading) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [uploading])

  const upload = async (form: HTMLFormElement) => {
    const data = new FormData(form)
    const file = data.get('file')
    if (!(file instanceof File) || file.size === 0) {
      setError('Pick a file to import.')
      return
    }
    setError(null)
    stopped.current = false
    setSending({ percent: 0, rows: 0 })

    let id: string | null = null
    let headers: string[] | null = null
    let batch: string[][] = []
    let characters = 0
    let sent = 0
    let percent = 0

    const flush = async () => {
      if (!id || batch.length === 0) return
      const rows = batch
      await withRetry(() => api.crm.imports.append.mutate({ id: id!, from: sent, rows }))
      sent += rows.length
      batch = []
      characters = 0
      setSending({ percent, rows: sent })
    }

    try {
      const onRead = (bytes: number) => {
        const next = Math.floor((bytes / file.size) * 100)
        if (next === percent) return
        percent = next
        setSending({ percent, rows: sent })
      }
      for await (const row of rowsOf(file, onRead)) {
        if (stopped.current) throw new Stopped()
        if (row.every((cell) => cell.trim() === '')) continue
        if (!headers) {
          headers = row
          continue
        }
        // Not until there is a row to put in it, so an empty file makes no run.
        id ??= (
          await api.crm.imports.begin.mutate({
            what: String(data.get('object') ?? ''),
            source: String(data.get('source') ?? '') || null,
            filename: file.name,
            headers,
          })
        ).id
        batch.push(row)
        characters += row.reduce((total, cell) => total + cell.length, 0)
        if (batch.length >= BATCH_ROWS || characters >= BATCH_CHARS) await flush()
      }
      if (!headers) throw new Error('That file has no rows in it.')
      if (!id) throw new Error('That file has a header row and nothing under it.')
      await flush()
      await withRetry(() => api.crm.imports.finish.mutate({ id: id! }))
      router.push(importsPath(account, id))
    } catch (cause) {
      if (id) await api.crm.imports.cancel.mutate({ id }).catch(() => undefined)
      setError(cause instanceof Stopped ? null : errorMessage(cause))
      setSending(null)
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void upload(event.currentTarget)
      }}
      className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-6 shadow-panel"
    >
      <h2 className="text-base font-semibold">Import a file</h2>
      <p className="text-secondary">One-time import from a file, directly into the CRM.</p>
      <fieldset disabled={uploading} className="flex min-w-0 flex-col gap-3">
        <ImportKindField options={kinds} />

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
          hint="CSV or XLSX, any size. Nothing is written until you have seen the preview."
        >
          <input
            id="import-file"
            name="file"
            type="file"
            required
            accept=".csv,.tsv,.txt,.xlsx"
            className="w-full min-w-0 rounded-hs border border-line bg-fill px-3 py-1.5"
          />
        </Field>
      </fieldset>

      {error ? <Alert>{error}</Alert> : null}

      {sending ? (
        <div className="flex flex-col gap-2">
          <div
            role="progressbar"
            aria-label="Upload"
            aria-valuenow={sending.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 w-full overflow-hidden rounded-hs bg-fill"
          >
            <div className="h-full bg-accent" style={{ width: `${sending.percent}%` }} />
          </div>
          <p className="text-secondary tabular-nums" aria-live="polite">
            Read {sending.percent}% of the file, {formatNumber(sending.rows)} rows sent. Keep this tab open until
            the mapper opens.
          </p>
          <div>
            <Button
              onClick={() => {
                stopped.current = true
              }}
            >
              Stop the upload
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="submit" variant="primary">
            Upload and map columns
          </Button>
        </div>
      )}
    </form>
  )
}
