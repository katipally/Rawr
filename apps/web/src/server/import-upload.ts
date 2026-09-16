import { randomUUID } from 'node:crypto'
import {
  beginImportParse,
  beginImportUpload,
  cancelImportRun,
  finishImportParse,
  IMPORT_KINDS,
  readImportUpload,
  recordUploadPart,
  UPLOAD_PART_BYTES,
  writeParsedRows,
  type AccountContext,
  type ImportKind,
  type ImportRow,
  type Mapping,
} from '@rawr/db'
import { csvReader, sniffDelimiter } from '~/lib/csv.ts'
import {
  abortMultipart,
  beginMultipart,
  completeMultipart,
  NOT_CONFIGURED,
  objectStream,
  removeObject,
  storageConfigured,
  uploadPart,
} from './storage.ts'

/** An import's file, from the browser to storage to rows.
 *
 *  The browser does not read the file any more. It sends the bytes a part at a
 *  time and stops, which is what makes an import survive the tab: the last part
 *  landing is the last thing the page is needed for, and a part is numbered, so a
 *  tab closed half way through resumes from the parts that are missing rather
 *  than starting the file again.
 *
 *  Reading the file is the server's, in one pass, which is also why an import is
 *  now fast: the rows used to arrive as one request per thousand of them, each
 *  one a round trip across the country. */

/** Enough that a wide export's row is not the limit, small enough that a file of
 *  this size is a mistake rather than a migration. */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024

/** A workbook is a zip: it cannot be read a chunk at a time, so the whole of it is
 *  held in memory while it is opened. A CSV of any size streams instead. */
const MAX_WORKBOOK_BYTES = 200 * 1024 * 1024

/** Rows handed to the database at once while the file is being read. Large enough
 *  that an 88,000-row file is under twenty round trips, small enough that a failure
 *  loses seconds rather than the file. */
const PARSE_BATCH = 5_000

export const READABLE = /\.(csv|tsv|txt|xlsx)$/i

/** Storage keys are the account's prefix and then anything, so a filename is only
 *  ever a label: the segment that makes the key unique is a fresh uuid, and a name
 *  with a slash, a traversal or a zero byte in it cannot reach outside the prefix. */
const keyFor = (accountId: string, filename: string): string =>
  `${accountId}/imports/${randomUUID()}/${filename.replaceAll(/[^\w.-]+/g, '_').slice(-120)}`

const contentType = (filename: string): string =>
  /\.xlsx$/i.test(filename)
    ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    : 'text/csv'

export const assertStorage = (): void => {
  if (!storageConfigured) throw new Error(NOT_CONFIGURED)
}

/** Which part a byte offset belongs to. Part numbers start at one because S3's do. */
export const partNumberAt = (offset: number): number => Math.floor(offset / UPLOAD_PART_BYTES) + 1

export const startUpload = async (
  ctx: AccountContext,
  input: { what: string; source: string | null; filename: string; fileBytes: number },
): Promise<{ id: string; partBytes: number }> => {
  assertStorage()
  if (!READABLE.test(input.filename)) {
    throw new Error('Upload a .csv or a .xlsx file. Older .xls files need saving as one of those first.')
  }
  if (input.fileBytes <= 0) throw new Error('That file is empty.')
  if (input.fileBytes > MAX_FILE_BYTES) throw new Error('That file is larger than this can import.')

  const shape = (IMPORT_KINDS as readonly string[]).includes(input.what) && input.what !== 'records'
  const key = keyFor(ctx.accountId, input.filename)
  const uploadId = await beginMultipart(key, contentType(input.filename))
  const { id } = await beginImportUpload(ctx, {
    kind: shape ? (input.what as ImportKind) : 'records',
    // A shape file is matched against contacts whatever it names.
    objectKey: shape ? 'contact' : input.what,
    source: input.source,
    filename: input.filename,
    fileBytes: input.fileBytes,
    uploadKey: key,
    uploadId,
  })
  return { id, partBytes: UPLOAD_PART_BYTES }
}

/** One part of the file. Refusing a part the run already holds rather than
 *  uploading it again is what makes a resumed upload cost only what is missing. */
export const acceptPart = async (
  ctx: AccountContext,
  id: string,
  n: number,
  body: Uint8Array,
): Promise<{ uploadedBytes: number }> => {
  assertStorage()
  const run = await readImportUpload(ctx, id)
  if (!run) throw new Error('That import no longer exists.')
  if (run.state !== 'uploading' || !run.uploadKey || !run.uploadId) {
    throw new Error('That upload is over, so no more of the file can be added to it.')
  }
  const held = run.parts.find((part) => part.n === n)
  if (held) return { uploadedBytes: run.uploadedBytes }

  const etag = await uploadPart(run.uploadKey, run.uploadId, n, body)
  return recordUploadPart(ctx, id, { n, etag, bytes: body.byteLength })
}

/** Every part is in. Storage assembles them into the object and the run passes to
 *  the server, which is the point the browser stops mattering. */
export const sealUpload = async (ctx: AccountContext, id: string): Promise<void> => {
  assertStorage()
  const run = await readImportUpload(ctx, id)
  if (!run) throw new Error('That import no longer exists.')
  // Asked twice when the first answer never reached the browser.
  if (run.state !== 'uploading') return
  if (!run.uploadKey || !run.uploadId) throw new Error('That upload was stopped. Upload the file again.')
  if (run.parts.length === 0) throw new Error('None of that file arrived. Upload it again.')
  if (run.uploadedBytes !== run.fileBytes) {
    throw new Error('Some of that file is missing. Upload it again.')
  }

  await completeMultipart(run.uploadKey, run.uploadId, run.parts)
  await beginImportParse(ctx, id)

  // Started here and not awaited, so the answer to "the last part landed" is
  // immediate and the file is already being read by the time the page asks. The
  // worker's sweep is what makes this safe to drop: a run left in 'parsing'
  // because this process died is picked up again, and picks up where it stopped.
  void parseUploadedFile(ctx, id).catch(() => {
    // Whatever went wrong is the sweep's to retry and the run's to report.
  })
}



/** Stopping an import, and taking its file with it. An abandoned multipart upload
 *  is not an object: it does not appear in a listing and nothing cleans it up, so
 *  it has to be abandoned explicitly or it is billed for ever. */
export const discardUpload = async (ctx: AccountContext, id: string): Promise<void> => {
  const run = await readImportUpload(ctx, id)
  await cancelImportRun(ctx, id)
  if (!run?.uploadKey || !storageConfigured) return
  const forget = run.uploadId
    ? abortMultipart(run.uploadKey, run.uploadId)
    : removeObject(run.uploadKey)
  await forget.catch(() => {
    // The run is stopped either way. A file left behind is worth less than an
    // error on the button that stopped it.
  })
}

/** The file's rows, header first, read from storage. */
async function* rowsOf(key: string, filename: string, bytes: number): AsyncGenerator<string[]> {
  const stream = await objectStream(key)
  if (/\.xlsx$/i.test(filename)) {
    if (bytes > MAX_WORKBOOK_BYTES) {
      throw new Error('That workbook is too large to open. Save it as CSV and import that instead.')
    }
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    try {
      await workbook.xlsx.load(await new Response(stream).arrayBuffer())
    } catch {
      throw new Error('That .xlsx file could not be opened. Re-save it from your spreadsheet app, or export it as CSV.')
    }
    const sheet = workbook.worksheets[0]
    if (!sheet) throw new Error('That workbook has no sheets in it.')
    const rows: string[][] = []
    // values is 1-based with a leading hole, which is why the slice is here.
    sheet.eachRow({ includeEmpty: false }, (row) => {
      rows.push((Array.isArray(row.values) ? row.values.slice(1) : []).map(cellText))
    })
    yield* rows
    return
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let csv: ReturnType<typeof csvReader> | null = null
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    const text = decoder.decode(chunk.value, { stream: true })
    csv ??= csvReader(/\.tsv$/i.test(filename) ? '\t' : sniffDelimiter(text))
    yield* csv.push(text)
  }
  csv ??= csvReader()
  yield* csv.push(decoder.decode())
  yield* csv.end()
}

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

/** Blank names would collide in the mapping and duplicates would silently drop a
 *  column, so both are made unique and visible. The same rule the row path uses,
 *  applied here because this path is where the headers are first seen. */
const nameHeaders = (raw: string[]): string[] => {
  const seen = new Map<string, number>()
  return raw.map((header, index) => {
    const base = header.trim() || `Column ${index + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base} (${count + 1})`
  })
}

/** The file, read into rows.
 *
 *  Resumable rather than transactional: the run remembers how many rows it holds,
 *  and a second attempt skips those and writes the rest. Rows are keyed by their
 *  position in the file, so a batch that was half written when the process died is
 *  completed rather than duplicated. */
export const parseUploadedFile = async (
  ctx: AccountContext,
  id: string,
): Promise<{ id: string; rows: number; suggested: Mapping; previousMapping: Mapping | null }> => {
  assertStorage()
  const run = await readImportUpload(ctx, id)
  if (!run) throw new Error('That import no longer exists.')
  if (run.state === 'mapping') throw new Error('That file has already been read.')
  if (run.state !== 'parsing' || !run.uploadKey) {
    throw new Error('That file is not waiting to be read.')
  }

  let headers: string[] | null = null
  /** Data rows read out of the file so far, which is also the position the next
   *  one is stored at. */
  let seen = 0
  // What an attempt that did not finish already wrote. Those rows are skipped
  // rather than read again, so a retry costs the rest of the file and not all of it.
  const already = run.totalRows
  let batchFrom = already
  let batch: ImportRow[] = []

  const flush = async () => {
    if (!headers || batch.length === 0) return
    await writeParsedRows(ctx, id, batchFrom, batch, headers)
    batchFrom += batch.length
    batch = []
  }

  for await (const row of rowsOf(run.uploadKey, run.filename, run.fileBytes)) {
    if (row.every((cell) => cell.trim() === '')) continue
    if (!headers) {
      headers = nameHeaders(row)
      if (headers.length === 0) throw new Error('That file has no columns in it.')
      continue
    }
    const at = seen
    seen += 1
    if (at < already) continue
    batch.push(Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])))
    if (batch.length >= PARSE_BATCH) await flush()
  }
  await flush()

  if (!headers) throw new Error('That file has no rows in it.')
  if (seen === 0) throw new Error('That file has a header row and nothing under it.')
  // The columns still have to reach the run when a retry found every row already
  // written, because the first attempt died before it recorded them.
  if (seen === already) await writeParsedRows(ctx, id, seen, [], headers)

  const settled = await finishImportParse(ctx, id)
  // The rows are in the table now, so the object has done its job. Left behind it
  // would be a copy of somebody's export sitting in storage for ever, and one
  // nothing points at: the run no longer needs it and nothing else knows the key.
  await removeObject(run.uploadKey).catch(() => {
    // The import is done either way. A file left behind is worth less than an
    // import that reports a failure it did not have.
  })
  return { ...settled, rows: seen }
}
