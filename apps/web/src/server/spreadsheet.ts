import ExcelJS from 'exceljs'

export type Sheet = { headers: string[]; rows: Record<string, string>[] }

/** A cap, not a guess: beyond this the file belongs in a database import, not in a
 *  browser upload, and saying so beats timing out. */
export const MAX_ROWS = 100_000
export const MAX_BYTES = 40 * 1024 * 1024

export class SpreadsheetError extends Error {}

/** RFC 4180 by hand rather than a dependency: quoted fields, doubled quotes inside
 *  them, and newlines inside quotes are the whole specification, and a parser we
 *  own is one fewer supply chain to audit. */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  // A byte order mark at the start of a file exported from Excel would otherwise
  // become part of the first header name.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!

    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Blank names would collide in the mapping, and duplicates would silently drop a
 *  column, so both are made unique and visible rather than fixed up quietly. */
const nameHeaders = (raw: string[]): string[] => {
  const seen = new Map<string, number>()
  return raw.map((header, index) => {
    const base = header.trim() || `Column ${index + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base} (${count + 1})`
  })
}

const toSheet = (grid: string[][]): Sheet => {
  const [headerRow, ...body] = grid.filter((row) => row.some((cell) => cell.trim() !== ''))
  if (!headerRow) throw new SpreadsheetError('That file has no rows in it.')
  if (body.length === 0) throw new SpreadsheetError('That file has a header row and nothing under it.')
  if (body.length > MAX_ROWS) {
    throw new SpreadsheetError(
      `That file has ${body.length.toLocaleString()} rows. The limit is ${MAX_ROWS.toLocaleString()}; split it and import each part.`,
    )
  }

  const headers = nameHeaders(headerRow)
  return {
    headers,
    rows: body.map((row) =>
      Object.fromEntries(headers.map((header, index) => [header, (row[index] ?? '').trim()])),
    ),
  }
}

/** Cells come back as rich text, formulas, dates and hyperlinks. Each becomes the
 *  string a person would see in the cell, because that is what they mapped. */
const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const cell = value as { text?: unknown; result?: unknown; richText?: { text: string }[]; hyperlink?: string }
    if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text).join('')
    if (cell.text !== undefined) return String(cell.text)
    if (cell.result !== undefined) return String(cell.result)
    if (cell.hyperlink) return cell.hyperlink
    return ''
  }
  return String(value)
}

export const readSpreadsheet = async (file: File): Promise<Sheet> => {
  if (file.size > MAX_BYTES) {
    throw new SpreadsheetError(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is ${MAX_BYTES / 1024 / 1024}MB.`,
    )
  }

  const name = file.name.toLowerCase()
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    return toSheet(parseCsv(await file.text()))
  }

  if (!name.endsWith('.xlsx')) {
    throw new SpreadsheetError('Upload a .csv or a .xlsx file. Older .xls files need saving as one of those first.')
  }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await file.arrayBuffer())
  const sheet = workbook.worksheets[0]
  if (!sheet) throw new SpreadsheetError('That workbook has no sheets in it.')

  const grid: string[][] = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = []
    // values is 1-based with a leading hole, which is why the slice is here.
    const values = Array.isArray(row.values) ? row.values.slice(1) : []
    for (const value of values) cells.push(cellText(value))
    grid.push(cells)
  })

  return toSheet(grid)
}
