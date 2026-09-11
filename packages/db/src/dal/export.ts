import { and, asc, eq, gt, isNotNull } from 'drizzle-orm'
import { importRow, importRun } from '../schema/imports.ts'
import { assertCanDo, type AccountContext } from './context.ts'
import { withAccount, writeAudit } from './index.ts'
import { listRecords } from './records.ts'
import { getRegistry, objectOrThrow } from './registry.ts'
import { formatForCsv } from './values.ts'
import type { Cursor, FilterGroup, Sort } from './query.ts'

const PAGE = 200

/** Excel reads a CSV without one as its local code page, so every accented name
 *  arrives mangled. The importer strips it, so a file goes out and back unchanged. */
const BOM = '\uFEFF'

const quoted = (value: string): string =>
  /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

/** Yields the CSV of exactly the current view: its filters, its columns, its sort
 *  order, nothing else. Streamed a page at a time, so memory holds one page
 *  whatever the view's size, and no row count is too many to download. A8. */
export async function* exportCsv(
  ctx: AccountContext,
  input: { objectKey: string; columns: string[]; filters: FilterGroup[]; sorts: Sort[]; search?: string },
): AsyncGenerator<string> {
  assertCanDo(ctx, 'export')
  const registry = await getRegistry(ctx)
  const object = objectOrThrow(registry, input.objectKey)
  const fields = input.columns.flatMap((key) => {
    const field = object.byKey.get(key)
    return field ? [field] : []
  })
  if (fields.length === 0) throw new Error('Pick at least one column to export.')

  yield `${BOM}${fields.map((field) => quoted(field.label)).join(',')}\n`

  let cursor: Cursor | null = null
  let emitted = 0
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

/** Rows of the error file read per query. */
const ERROR_PAGE = 1000

/** Every row an import refused, as a file the person can fix and re-upload: the
 *  file's own columns in the file's own order, so the corrected file maps the same
 *  way. Paged by position off the primary key, so a run that refused ninety
 *  thousand rows streams them rather than holding them. A8. */
export async function* importErrorCsv(ctx: AccountContext, id: string): AsyncGenerator<string> {
  const [run] = await withAccount(ctx, (tx) =>
    tx.select({ headers: importRun.headers }).from(importRun).where(eq(importRun.id, id)).limit(1),
  )
  if (!run) throw new Error('That import does not exist.')
  const headers = run.headers as string[]

  yield `${BOM}${['Row', 'Reason', ...headers].map(quoted).join(',')}\n`
  let after = -1
  for (;;) {
    const page = await withAccount(ctx, (tx) =>
      tx
        .select({ position: importRow.position, values: importRow.values, reason: importRow.reason })
        .from(importRow)
        .where(and(eq(importRow.runId, id), isNotNull(importRow.reason), gt(importRow.position, after)))
        .orderBy(asc(importRow.position))
        .limit(ERROR_PAGE),
    )
    for (const row of page) {
      const values = row.values as Record<string, string>
      yield `${[String(row.position + 2), row.reason ?? '', ...headers.map((header) => values[header] ?? '')].map(quoted).join(',')}\n`
    }
    if (page.length < ERROR_PAGE) return
    after = page.at(-1)!.position
  }
}
