'use client'

import { Avatar, Button, DataTable, DropdownMenu, EmptyState, IconButton, Pagination, buttonClass, cn, type Column } from '@rawr/ui'
import { ArrowDown, ArrowUp, ArrowUpDown, Download, EllipsisVertical, PanelRight } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useNavigation } from '~/components/navigation.tsx'
import { useState } from 'react'
import type { FieldType } from '@rawr/db'
import { objectView, recordPath, type ListParams } from '~/lib/links.ts'
import { sortWords } from '~/lib/sort-labels.ts'
import { replaceParams } from '~/lib/url-params.ts'
import { useOrigin } from '~/lib/use-origin.ts'
import { BulkBar } from './bulk-bar.tsx'
import { NAME_PARTS } from './column-chooser.ts'
import type { EditableField } from './field-input.tsx'
import { EMPTY_VALUE, Value } from './value.tsx'
import { RecordPreview } from './record-preview.tsx'
import { ScoreRing } from './score-ring.tsx'
import { useFormat, useZone } from '~/components/zone.tsx'

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
  /** Base query for the page links, so paging keeps the filters and the sort. */
  params: ListParams
  /** What the rows are sorted by, so the header of that column says so. */
  sorts: { key: string; direction: 'asc' | 'desc' }[]
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
const DEFAULT_PAGE_SIZE = 25

const WITH_AVATAR = new Set(['contact', 'company'])

export const RecordTable = ({
  account,
  object,
  view,
  columns,
  rows,
  params,
  sorts,
  totalHint,
  objectLabel,
  objectPlural,
  bulkFields,
  exportHref,
  previewFields,
  canWrite,
}: RecordTableProps) => {
  const fmt = useFormat()
  const zone = useZone()
  const origin = useOrigin()
  const preview = useSearchParams().get('preview')
  const { navigate } = useNavigation()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const canBulk = bulkFields.length > 0

  // Ids that are no longer on screen cannot be edited from here, and keeping them
  // ticked would make the count lie about what Apply is going to touch.
  const onPage = new Set(rows.map((row) => row.id))
  const live = [...selected].filter((id) => onPage.has(id))

  const goTo = (next: ListParams) => navigate(objectView(account, object, view, 'list', { ...params, ...next, page: undefined }))
  const keys = columns.map((column) => column.key)
  const namedPerson = object === 'contact' && NAME_PARTS.includes(keys[0] ?? '')
  const shown = namedPerson ? columns.filter((column, index) => index === 0 || !NAME_PARTS.includes(column.key)) : columns

  const headerAside = (column: TableColumn, index: number) => {
    const sorted = sorts[0]?.key === column.key ? sorts[0].direction : null
    const SortIcon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ArrowUpDown
    const words = sortWords(column.type)
    // The Name column stands for both halves of a person's name, so it goes as one.
    const owned = index === 0 && namedPerson ? NAME_PARTS : [column.key]
    const rest = keys.filter((key) => !owned.includes(key))
    return (
      <>
        <button
          type="button"
          aria-label={sorted === 'desc' ? `Sort ${column.label} ascending` : `Sort ${column.label} descending`}
          onClick={() => goTo({ sort: sorted === 'desc' ? column.key : `-${column.key}` })}
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-pill text-body hover:bg-fill-hover',
            sorted ? null : 'opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100',
          )}
        >
          <SortIcon aria-hidden="true" className="size-3.5" />
        </button>
        <DropdownMenu
          label={`${column.label} column`}
          groups={[
            {
              key: 'sort',
              items: [
                { key: 'asc', label: words.asc, checked: sorted === 'asc', onSelect: () => goTo({ sort: column.key }) },
                { key: 'desc', label: words.desc, checked: sorted === 'desc', onSelect: () => goTo({ sort: `-${column.key}` }) },
              ],
            },
            {
              key: 'columns',
              items: [
                { key: 'add', label: 'Add column', onSelect: () => replaceParams({ columns: 'edit' }) },
                {
                  key: 'remove',
                  label: 'Remove column',
                  // A table needs one column to be a table at all.
                  disabled: rest.length === 0,
                  onSelect: () => goTo({ cols: rest.join(',') }),
                },
              ],
            },
          ]}
          trigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label={`${column.label} column actions`}
              className="ml-auto grid size-6 shrink-0 place-items-center rounded-pill text-body opacity-0 hover:bg-fill-hover group-hover/header:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
            >
              <EllipsisVertical aria-hidden="true" className="size-4" />
            </button>
          )}
        />
      </>
    )
  }

  const tableColumns: Column<TableRow>[] = shown.map((column, index) => ({
    key: column.key,
    header: index === 0 && namedPerson ? 'Name' : column.label,
    align: column.numeric ? 'right' : 'left',
    width: index === 0 ? 240 : column.width,
    ...(sorts[0]?.key === column.key ? { sort: sorts[0].direction === 'asc' ? 'ascending' : 'descending' } : {}),
    headerAside: headerAside(column, index),
    render: (row) => {
      const value = row.values[column.key]
      const overdue = OVERDUE_FIELDS.has(column.key) && fmt.isPast(value)

      if (index === 0) {
        // The first column is the way into the record. It shows its own field's
        // value, falling back to the record's display name when that field is
        // empty, so a contact with no first name is still openable and still
        // named rather than rendering an empty link.
        const own = namedPerson ? '' : row.labels[column.key] || (value === null || value === undefined ? '' : String(value))
        const text = own.trim() || row.displayName
        return (
          <span className="flex items-center gap-2">
            {WITH_AVATAR.has(object) ? <Avatar name={text} size="sm" /> : null}
            <Link
              href={recordPath(account, object, row.id, { from: origin })}
              className="block min-w-0 truncate font-semibold hover:text-accent hover:underline"
              title={text}
            >
              {text}
            </Link>
            {/* Shown with the row hovered or the button focused, and always on a
                device with no hover to show it with. No width until then, so a
                hidden button does not cut the name short. */}
            <IconButton
              label="Preview"
              icon={<PanelRight aria-hidden="true" className="size-3.5" />}
              onClick={(event) => {
                event.stopPropagation()
                replaceParams({ preview: row.id })
              }}
              className="h-6 w-0 border-0 border-line-strong bg-surface text-body opacity-0 focus-visible:w-6 focus-visible:border focus-visible:opacity-100 [@media(hover:none)]:w-6 [@media(hover:none)]:border [@media(hover:none)]:opacity-100 [tr:hover_&]:w-6 [tr:hover_&]:border [tr:hover_&]:opacity-100"
            />
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
        <span
          title={full || undefined}
          className={cn(
            'block min-w-0 truncate',
            column.type === 'multi_select' && 'whitespace-normal',
            overdue && 'font-medium text-error',
          )}
        >
          <Value format={fmt}
            type={column.type}
            value={value}
            label={row.labels[column.key]}
            currency={row.values.currency}
            placeholder={EMPTY_VALUE}
            oneLine
          />
        </span>
      )
    },
  }))

  const current = Math.max(1, Math.trunc(Number(params.page)) || 1)
  const perPage = Math.max(1, Number(params.limit ?? 0) || DEFAULT_PAGE_SIZE)
  const offset = (current - 1) * perPage
  const toPage = (page: number) =>
    navigate(objectView(account, object, view, 'list', { ...params, page: page > 1 ? String(page) : undefined }))

  const pager = (
    <Pagination
      format={fmt.number}
      className="shrink-0 py-0"
      count={rows.length}
      offset={offset}
      total={totalHint ?? undefined}
      perPage={perPage}
      noun={`${objectLabel.toLowerCase()} records`}
      onPrevious={() => toPage(current - 1)}
      onNext={() => toPage(current + 1)}
      onPage={toPage}
      // A new page size starts again from the first page: page four of 25 rows
      // and page four of 100 are different rows.
      onPerPage={(size) => goTo({ limit: String(size) })}
    />
  )
  const bulking = canBulk && live.length > 0

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
        caption={`${object} records in the ${view} view`}
        {...(canBulk
          ? { selection: { selected, onChange: setSelected, noun: objectLabel.toLowerCase() } }
          : {})}
        headerBar={
          bulking ? (
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
          ) : null
        }
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
            action={
              params.q || params.filters ? (
                <Button variant="secondary" onClick={() => goTo({ q: undefined, filters: undefined })}>
                  {params.q ? 'Clear search and filters' : 'Clear filters'}
                </Button>
              ) : undefined
            }
          />
        }
      />

      <RecordPreview
        account={account}
        object={object}
        objectLabel={objectLabel}
        id={preview}
        fields={previewFields}
        canWrite={canWrite}
        from={origin}
        onClose={() => replaceParams({ preview: null })}
      />

      {/* HubSpot's footer: the total on the left, the pages in the middle, what to
          do with the whole list on the right. The export is a plain link so the
          browser downloads it and it survives a closed tab. */}
      <div className="-mx-3 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-line px-3 pt-2 sm:-mx-6 sm:px-6">
        <span className="inline-flex h-pill items-center rounded-pill bg-canvas px-4 text-small font-semibold">
          {fmt.number(totalHint ?? rows.length)}{' '}
          {((totalHint ?? rows.length) === 1 ? objectLabel : objectPlural).toLowerCase()}
        </span>
        {shown.some((column) => column.type === 'datetime') ? (
          <span className="text-small text-secondary">Times in {zone}</span>
        ) : null}
        {pager}
        <a
          href={exportHref}
          download
          className={buttonClass('secondary', 'h-pill min-h-0 no-underline')}
        >
          <Download aria-hidden="true" className="size-3.5" />
          Export
        </a>
      </div>
    </div>
  )
}
