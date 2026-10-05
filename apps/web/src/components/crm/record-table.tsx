'use client'

import { DataTable, EmptyState, Pagination, buttonClass, cn, type Column } from '@rawr/ui'
import { Download } from 'lucide-react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useNavigation } from '~/components/navigation.tsx'
import { useState } from 'react'
import type { FieldType } from '@rawr/db'
import { objectView, recordPath, type ListParams } from '~/lib/links.ts'
import { replaceParams } from '~/lib/url-params.ts'
import { useOrigin } from '~/lib/use-origin.ts'
import { BulkBar } from './bulk-bar.tsx'
import type { EditableField } from './field-input.tsx'
import { Value, isPast } from './value.tsx'
import { RecordPreview } from './record-preview.tsx'
import { ScoreRing } from './score-ring.tsx'
import { useZone } from '~/components/zone.tsx'

export type TableColumn = { key: string; label: string; type: FieldType; numeric: boolean; width: number }

export type TableRow = {
  id: string
  displayName: string
  values: Record<string, unknown>
  labels: Record<string, string>
  /** What the row was when it was read, sent back with a bulk edit. */
  version: string
}

export type RecordTableProps = {
  account: string
  object: string
  view: string
  columns: TableColumn[]
  rows: TableRow[]
  /** Base query for the next-page link, so paging keeps the filters and the sort. */
  params: ListParams
  nextCursor: string | undefined
  totalHint: number | null
  objectLabel: string
  objectPlural: string
  /** What a bulk edit may set. Empty for a role that cannot write, which is what
   *  removes the checkbox column entirely rather than showing a dead one. */
  bulkFields: EditableField[]
  /** The CSV of exactly this list: same filters, columns and sort. */
  exportHref: string
  /** The properties the preview panel opens on. */
  previewFields: TableColumn[]
  canWrite: boolean
}

const OVERDUE_FIELDS = new Set(['next_step_date', 'close_date'])

/** Matches the list page's own default, so the per-page control opens showing
 *  what the page actually asked for. */
const DEFAULT_PAGE_SIZE = 50

export const RecordTable = ({
  account,
  object,
  view,
  columns,
  rows,
  params,
  nextCursor,
  totalHint,
  objectLabel,
  objectPlural,
  bulkFields,
  exportHref,
  previewFields,
  canWrite,
}: RecordTableProps) => {
  const zone = useZone()
  const router = useRouter()
  const origin = useOrigin()
  const preview = useSearchParams().get('preview')
  const { navigate } = useNavigation()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const canBulk = bulkFields.length > 0

  // Ids that are no longer on screen cannot be edited from here, and keeping them
  // ticked would make the count lie about what Apply is going to touch.
  const onPage = new Set(rows.map((row) => row.id))
  const live = [...selected].filter((id) => onPage.has(id))

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
          <span className="relative flex items-center">
            <Link
              href={recordPath(account, object, row.id, { from: origin })}
              className="block min-w-0 flex-1 truncate font-medium"
              title={text}
              onClick={(event) => event.stopPropagation()}
            >
              {text}
            </Link>
            {/* Over the end of the name rather than beside it, so showing it does not
                cut the name short. Shown with the row hovered or the button focused,
                and always on a device with no hover to show it with. */}
            <button
              type="button"
              aria-label={`Preview ${text}`}
              onClick={(event) => {
                event.stopPropagation()
                replaceParams({ preview: row.id })
              }}
              className="absolute top-1/2 right-0 -translate-y-1/2 rounded-hs border border-line-strong bg-surface px-2 py-0.5 text-small opacity-0 hover:bg-fill focus-visible:opacity-100 [@media(hover:none)]:opacity-100 [tr:hover_&]:opacity-100"
            >
              Preview
            </button>
          </span>
        )
      }

      // The deal score reads as a ring, not as a number in a column of numbers:
      // the whole point of it is being scannable down a list.
      if (object === 'deal' && column.key === 'score') {
        const score = typeof value === 'number' ? value : null
        return <ScoreRing score={score} className="text-small" />
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
          <Value zone={zone}
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

  const pageHref = (next: ListParams): string => objectView(account, object, view, 'list', next)

  return (
    // The rows keep room to be read when the chrome above them is tall: past this
    // the page scrolls instead of the table shrinking to a header.
    <div className="flex min-h-[calc(var(--spacing-row)*8)] flex-1 flex-col gap-2">
      <DataTable
        fill
        storageKey={`${object}.${view}`}
        columns={tableColumns}
        rows={rows}
        rowKey={(row) => row.id}
        onRowClick={(row) => router.push(recordPath(account, object, row.id, { from: origin }))}
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
                : params.filters
                  ? 'No record matches these filters. Widen them, or clear them.'
                  : 'This view has no records yet. Import a file, or create one.'
            }
          />
        }
      />

      <RecordPreview
        account={account}
        object={object}
        id={preview}
        fields={previewFields}
        canWrite={canWrite}
        from={origin}
        onClose={() => replaceParams({ preview: null })}
      />

      {/* Below the list, not above it. The bar appears the moment a row is ticked,
          and above the table it pushed every row down by its own height, so the
          next click landed on the row after the intended one. Here the table box
          gives up the height instead, from its bottom edge, and no row moves. */}
      {canBulk && live.length > 0 ? (
        <div className="shrink-0">
          <BulkBar
            object={object}
            objectLabel={objectLabel}
            objectPlural={objectPlural}
            ids={live}
            versions={Object.fromEntries(rows.map((row) => [row.id, row.version]))}
            fields={bulkFields}
            onDone={() => setSelected(new Set())}
            onClear={() => setSelected(new Set())}
          />
        </div>
      ) : null}

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

      {/* HubSpot's footer: the total on the left, what to do with the whole list
          on the right. The export is a plain link so the browser downloads it and
          it survives a closed tab. */}
      <div className="-mx-3 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line px-3 pt-2 sm:-mx-6 sm:px-6">
        <span className="inline-flex h-8 items-center rounded-pill bg-canvas px-4 text-small font-semibold">
          {(totalHint ?? rows.length).toLocaleString()}{' '}
          {((totalHint ?? rows.length) === 1 ? objectLabel : objectPlural).toLowerCase()}
        </span>
        <a
          href={exportHref}
          download
          className={buttonClass('secondary', 'no-underline')}
        >
          <Download aria-hidden="true" className="size-3.5" />
          Export
        </a>
      </div>
    </div>
  )
}
