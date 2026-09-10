import type { AccountContext } from './context.ts'
import { withAccount, writeAudit } from './index.ts'
import { listRecords } from './records.ts'
import { getRegistry, objectOrThrow } from './registry.ts'
import { formatForCsv } from './values.ts'
import type { Cursor, FilterGroup, Sort } from './query.ts'

const PAGE = 200
/** A browser download, not a job. Beyond this the answer is the importer's own
 *  result file or a database export, not a link that times out halfway. */
const MAX_ROWS = 50_000

const quoted = (value: string): string =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

/** Yields the CSV of exactly the current view: its filters, its columns, its sort
 *  order, nothing else. Streamed a page at a time so a 50,000-row export never
 *  holds 50,000 rows in memory. A8. */
export async function* exportCsv(
  ctx: AccountContext,
  input: { objectKey: string; columns: string[]; filters: FilterGroup[]; sorts: Sort[]; search?: string },
): AsyncGenerator<string> {
  const registry = await getRegistry(ctx)
  const object = objectOrThrow(registry, input.objectKey)
  const fields = input.columns.flatMap((key) => {
    const field = object.byKey.get(key)
    return field ? [field] : []
  })
  if (fields.length === 0) throw new Error('Pick at least one column to export.')

  yield `${fields.map((field) => quoted(field.label)).join(',')}\n`

  let cursor: Cursor | null = null
  let emitted = 0
  let stoppedAtCap = false
  try {
    do {
      const page = await listRecords(ctx, {
        object: object.key,
        columns: input.columns,
        filters: input.filters,
        sorts: input.sorts,
        search: input.search ?? '',
        limit: PAGE,
        cursor,
      })

      for (const row of page.rows) {
        const cells = fields.map((field) => {
          // A relation exports as the name a person recognises, not as a uuid.
          const label = row.labels[field.key]
          return quoted(label !== undefined && label !== '' ? label : formatForCsv(field.type, row.values[field.key]))
        })
        yield `${cells.join(',')}\n`
        emitted += 1
      }

      cursor = page.nextCursor
      if (emitted >= MAX_ROWS) {
        stoppedAtCap = true
        yield `\n"Stopped at ${MAX_ROWS.toLocaleString()} rows. Narrow the view's filters and export again."\n`
        return
      }
    } while (cursor)
  } finally {
    // In `finally` because a download the person cancels halfway is still an
    // export of their data leaving the account, and a history that only records
    // the ones that finished is a history somebody can walk around.
    await withAccount(ctx, (tx) =>
      writeAudit(tx, ctx, {
        entity: 'export',
        entityId: null,
        action: 'export',
        before: null,
        after: {
          object: object.key,
          rows: emitted,
          columns: fields.map((field) => field.key),
          filters: summarise(input.filters, input.search ?? ''),
          stoppedAtCap,
        },
      }),
    )
  }
}

/** What the export was narrowed to, in one line, because an audit row saying
 *  "exported 40,000 contacts" without saying which forty thousand is not a
 *  record of anything. */
const summarise = (filters: FilterGroup[], search: string): string => {
  const parts = filters.flatMap((group) =>
    group.conditions.map((condition) =>
      `${condition.field} ${condition.operator}${
        condition.value === undefined || condition.value === null || condition.value === ''
          ? ''
          : ` ${Array.isArray(condition.value) ? condition.value.join(', ') : String(condition.value)}`
      }`.trim(),
    ),
  )
  if (search) parts.push(`matching "${search}"`)
  return parts.length > 0 ? parts.join('; ') : 'no filters, the whole object'
}

/** The failed rows of an import, as a file the person can fix and re-upload. Every
 *  original column is kept so the corrected file imports the same way. A8. */
export const errorCsv = (errors: { row: number; reason: string; values: Record<string, string> }[]): string => {
  const headers = [...new Set(errors.flatMap((error) => Object.keys(error.values)))]
  const lines = [['Row', 'Reason', ...headers].map(quoted).join(',')]
  for (const error of errors) {
    lines.push(
      [String(error.row), error.reason, ...headers.map((header) => error.values[header] ?? '')]
        .map(quoted)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}
