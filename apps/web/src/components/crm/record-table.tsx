'use client'

import { DataTable, EmptyState, Pagination, cn, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useNavigation } from '~/components/navigation.tsx'
import { useState } from 'react'
import type { FieldType, ObjectKey } from '@rawr/db'
import { objectView, recordPath, type ListParams } from '~/lib/links.ts'
import { BulkBar } from './bulk-bar.tsx'
import type { EditableField } from './field-input.tsx'
import { Value, isPast } from './value.tsx'

export type TableColumn = { key: string; label: string; type: FieldType; numeric: boolean; width: number }

export type TableRow = {
  id: string
  displayName: string
  values: Record<string, unknown>
  labels: Record<string, string>
}

export type RecordTableProps = {
  workspace: string
  object: ObjectKey
  view: string
  columns: TableColumn[]
  rows: TableRow[]
  /** Base query for the next-page link, so paging keeps the filters and the sort. */
  params: ListParams
  nextCursor: string | undefined
  sort: { key: string; direction: 'asc' | 'desc' } | null
  totalHint: number | null
  objectLabel: string
  /** What a bulk edit may set. Empty for a role that cannot write, which is what
   *  removes the checkbox column entirely rather than showing a dead one. */
  bulkFields: EditableField[]
}

const OVERDUE_FIELDS = new Set(['next_step_date', 'close_date'])

/** Matches the list page's own default, so the per-page control opens showing
 *  what the page actually asked for. */
const DEFAULT_PAGE_SIZE = 50

export const RecordTable = ({
  workspace,
  object,
  view,
  columns,
  rows,
  params,
  nextCursor,
  sort,
  totalHint,
  objectLabel,
  bulkFields,
}: RecordTableProps) => {
  const router = useRouter()
  const { navigate } = useNavigation()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const canBulk = bulkFields.length > 0

  // Ids that are no longer on screen cannot be edited from here, and keeping them
  // ticked would make the count lie about what Apply is going to touch.
  const onPage = new Set(rows.map((row) => row.id))
  const live = [...selected].filter((id) => onPage.has(id))

  const sortHref = (key: string): string => {
    // Clicking the sorted column flips it; clicking another starts descending,
    // which is what a person wants from a date or an amount.
    const direction = sort?.key === key && sort.direction === 'desc' ? 'asc' : 'desc'
    // A new order starts from the first page; a cursor from the old order is meaningless.
    const next: ListParams = { ...params, cursor: undefined, sort: direction === 'desc' ? `-${key}` : key }
    delete next.cursor
    return objectView(workspace, object, view, 'list', next)
  }

  const tableColumns: Column<TableRow>[] = columns.map((column, index) => ({
    key: column.key,
    header: column.label,
    align: column.numeric ? 'right' : 'left',
    width: index === 0 ? 240 : column.width,
    render: (row) => {
      const value = row.values[column.key]
      const overdue = OVERDUE_FIELDS.has(column.key) && isPast(value)

      if (index === 0) {
        // The first column is the way into the record. It shows its own field's
        // value, falling back to the record's display name when that field is
        // empty, so a contact with no first name is still openable and still
        // named rather than rendering an empty link.
        const own = row.labels[column.key] || (value === null || value === undefined ? '' : String(value))
        const text = own.trim() || row.displayName
        return (
          <Link
            href={recordPath(workspace, object, row.id)}
            className="block truncate font-medium"
            title={text}
            onClick={(event) => event.stopPropagation()}
          >
            {text}
          </Link>
        )
      }

      // Truncated with the full value on hover: a 500-character name must not
      // rewrite the row height of every other row on the page.
      const full = row.labels[column.key] || (typeof value === 'string' ? value : '')
      return (
        // Not a control. The handler only stops a click on a link inside the cell
        // from also opening the row, so there is no behaviour for a keyboard to
        // reach.
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: see above
        <span
          title={full || undefined}
          // A mailto or tel link inside a row that is itself clickable must open
          // the link, not the record.
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) event.stopPropagation()
          }}
          className={cn(
            'block min-w-0 truncate',
            column.type === 'multi_select' && 'whitespace-normal',
            overdue && 'font-medium text-error',
          )}
        >
          <Value
            type={column.type}
            value={value}
            label={row.labels[column.key]}
            currency={String(row.values.currency ?? 'USD')}
            placeholder="—"
            oneLine
          />
        </span>
      )
    },
  }))

  // Keyset pages have no numbers, so how far in we are is carried in the URL and
  // grows by the size of each page we walk past. A hand-edited value only makes
  // the label wrong, never the rows.
  const offset = Math.max(0, Number(params.skip ?? 0) || 0)
  const perPage = Math.max(1, Number(params.limit ?? 0) || DEFAULT_PAGE_SIZE)

  const pageHref = (next: ListParams): string => objectView(workspace, object, view, 'list', next)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* The header row is its own control strip so the sort links stay reachable
          by keyboard rather than being buried in the table header. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-secondary">
        <span className="flex flex-wrap items-center gap-1">
          Sort:
          {columns.slice(0, 6).map((column) => (
            <Link
              key={column.key}
              href={sortHref(column.key)}
              scroll={false}
              className={cn(
                'rounded-hs px-1.5 py-0.5 no-underline',
                sort?.key === column.key ? 'bg-accent-subtle text-link' : 'text-secondary',
              )}
            >
              {column.label}
              {sort?.key === column.key ? (sort.direction === 'desc' ? ' ↓' : ' ↑') : ''}
            </Link>
          ))}
        </span>
      </div>

      {canBulk && live.length > 0 ? (
        <BulkBar
          object={object}
          objectLabel={objectLabel}
          ids={live}
          fields={bulkFields}
          onDone={() => setSelected(new Set())}
          onClear={() => setSelected(new Set())}
        />
      ) : null}

      <DataTable
        fill
        storageKey={`${object}.${view}`}
        columns={tableColumns}
        rows={rows}
        rowKey={(row) => row.id}
        onRowClick={(row) => router.push(recordPath(workspace, object, row.id))}
        caption={`${object} records in the ${view} view`}
        {...(canBulk
          ? { selection: { selected, onChange: setSelected, noun: objectLabel.toLowerCase() } }
          : {})}
        empty={
          <EmptyState
            title="Nothing matches this view"
            description={
              params.q
                ? `No record matches “${params.q}”. Clear the search, or widen the filters.`
                : 'This view has no records yet. Import a file, or create one.'
            }
          />
        }
      />

      {/* Previous is the browser's own history, because a keyset cursor points
          forward only and there is no address to jump back to. */}
      <Pagination
        className="shrink-0"
        count={rows.length}
        offset={offset}
        total={totalHint ?? undefined}
        hasMore={Boolean(nextCursor)}
        perPage={perPage}
        noun={`${objectLabel.toLowerCase()} records`}
        onPrevious={() => {
          if (offset === 0) return
          router.back()
        }}
        onNext={() => {
          if (!nextCursor) return
          navigate(
            pageHref({ ...params, cursor: nextCursor, skip: String(offset + rows.length) }),
          )
        }}
        onPerPage={(size) =>
          // A new page size restarts the walk: a cursor from a 25-row page means
          // nothing to a 100-row one, and neither does the offset it came with.
          navigate(pageHref({ ...params, limit: String(size), cursor: undefined, skip: undefined }))
        }
      />
    </div>
  )
}
