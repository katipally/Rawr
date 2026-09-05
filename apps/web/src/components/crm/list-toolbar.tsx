'use client'

import { Badge, Button, Checkbox, IconButton, Modal, TextInput, Tooltip, useToast } from '@rawr/ui'
import { ArrowDown, ArrowUp, BookmarkPlus, Columns3, Download, Filter, Search, X } from 'lucide-react'
import { useNavigation } from '~/components/navigation.tsx'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import type { ObjectKey } from '@rawr/db'
import { encodeFilters, objectView, type ListParams, type ViewKind } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { FilterBuilder, type FilterField, type Group } from './filter-builder.tsx'
import { CreateRecordDialog, type CreateField } from './create-record.tsx'

export type ListToolbarProps = {
  workspace: string
  object: ObjectKey
  objectLabel: string
  view: string
  viewId: string | null
  kind: ViewKind
  params: ListParams
  filters: Group[]
  columns: string[]
  sorts: { key: string; direction: 'asc' | 'desc' }[]
  filterFields: FilterField[]
  createFields: CreateField[]
  canWrite: boolean
  /** The view's own name, so "update this view" can save without renaming it. */
  viewLabel: string
  exportHref: string
  /** Every field the object has, for the column chooser. Ordered as the registry
   *  orders them, which is the order a person sees on the record page. */
  allColumns: { key: string; label: string }[]
}

/** A count pinned to the corner of an icon button. The number is what the label
 *  used to carry in words, and losing it would make "Filters" and "Filters, three
 *  applied" look identical. The tooltip and the accessible name still say it in
 *  full, so this is decoration for the eye only. */
const Counted = ({
  count,
  tone,
  children,
}: {
  count: number
  tone: 'accent' | 'neutral'
  children: ReactNode
}) => (
  <span className="relative inline-flex shrink-0">
    {children}
    {count > 0 ? (
      <span aria-hidden="true" className="pointer-events-none absolute -top-1 -right-1">
        <Badge tone={tone}>{count}</Badge>
      </span>
    ) : null}
  </span>
)

export const ListToolbar = ({
  workspace,
  object,
  objectLabel,
  view,
  viewId,
  kind,
  params,
  filters,
  columns,
  sorts,
  filterFields,
  createFields,
  canWrite,
  viewLabel,
  exportHref,
  allColumns,
}: ListToolbarProps) => {
  const { navigate } = useNavigation()
  const toast = useToast()
  const [search, setSearch] = useState(params.q ?? '')
  const [showFilters, setShowFilters] = useState(false)
  const [showSave, setShowSave] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  // The + in the top bar links here with ?new=1 rather than carrying its own copy
  // of the create form, so there is one create dialog per object and it always
  // knows the object's real fields.
  const query = useSearchParams()
  const askedToCreate = query.get('new') === '1'
  // "Add view" on the tab bar links here rather than carrying a second copy of
  // this dialog, the same way the + in the top bar links here to create a record.
  const askedForView = query.get('view') === 'new'
  useEffect(() => {
    if (askedToCreate && canWrite) setShowCreate(true)
  }, [askedToCreate, canWrite])
  useEffect(() => {
    if (askedForView && canWrite) setShowSave(true)
  }, [askedForView, canWrite])
  const [showColumns, setShowColumns] = useState(false)
  const [draftColumns, setDraftColumns] = useState(columns)
  const [viewName, setViewName] = useState('')
  const [shared, setShared] = useState(true)
  const [saving, setSaving] = useState(false)

  const goTo = (next: ListParams) => {
    const merged: ListParams = { ...params, ...next }
    delete merged.cursor
    navigate(objectView(workspace, object, view, kind, merged))
  }

  const activeConditions = filters.reduce((sum, group) => sum + group.conditions.length, 0)

  /** One write behind both buttons. `into` null creates a new view under the
   *  typed name; `into` an id overwrites that view's arrangement and keeps its
   *  name, because updating a view must never quietly rename it. */
  const writeView = async (into: string | null, name: string, nextColumns = columns) => {
    setSaving(true)
    try {
      const saved = await api.crm.views.save.mutate({
        object,
        id: into,
        name,
        // 'list' is the URL segment; the stored kind for it is 'table'. The
        // other two are the same word in both places.
        kind: kind === 'list' ? 'table' : kind,
        columns: nextColumns,
        filters: filters as never,
        sorts,
        isShared: shared,
      })
      setShowSave(false)
      setShowColumns(false)
      if (into) {
        toast('success', `Saved to “${saved.name}”.`)
        // The view now holds these columns, so the ad-hoc set in the URL would
        // only shadow what was just saved.
        navigate(objectView(workspace, object, saved.slug, kind, { ...params, cols: undefined }))
      } else {
        toast('success', `Saved as “${saved.name}”. Its address is /views/${saved.slug}/${kind}.`)
        navigate(objectView(workspace, object, saved.slug, kind, { q: params.q }))
      }
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setSaving(false)
    }
  }

  const closeSave = () => {
    setShowSave(false)
    // Drop ?view=new so a refresh, or a step back, does not reopen it.
    if (askedForView) navigate(objectView(workspace, object, view, kind, params))
  }

  const labelOf = (key: string): string =>
    allColumns.find((field) => field.key === key)?.label ?? key

  const openColumns = () => {
    setDraftColumns(columns)
    setShowColumns(true)
  }

  const move = (index: number, by: -1 | 1) => {
    const next = [...draftColumns]
    const target = index + by
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved!)
    setDraftColumns(next)
  }

  return (
    <div className="flex flex-col gap-2">
      {/* The search keeps its own row on a narrow viewport rather than sharing one
          with four buttons and overlapping them. */}
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:min-w-64 sm:flex-1"
          onSubmit={(event) => {
            event.preventDefault()
            goTo({ q: search })
          }}
        >
          <TextInput
            type="search"
            value={search}
            aria-label={`Search ${objectLabel.toLowerCase()}`}
            placeholder={`Search ${objectLabel.toLowerCase()}`}
            onChange={(event) => setSearch(event.target.value)}
            className="min-w-0 flex-1"
          />
          <IconButton
            type="submit"
            label={`Search ${objectLabel.toLowerCase()}`}
            icon={<Search size={16} />}
          />
          {params.q ? (
            <IconButton
              label="Clear the search"
              icon={<X size={16} />}
              onClick={() => { setSearch(''); goTo({ q: undefined }) }}
            />
          ) : null}
        </form>

        <Counted count={activeConditions} tone="accent">
          <IconButton
            label={activeConditions > 0 ? `Filters (${activeConditions} applied)` : 'Filters'}
            icon={<Filter size={16} />}
            tone={showFilters ? 'accent' : 'default'}
            aria-expanded={showFilters}
            onClick={() => setShowFilters((open) => !open)}
          />
        </Counted>

        <Counted count={columns.length} tone="neutral">
          <IconButton
            label={`Columns (${columns.length} shown)`}
            icon={<Columns3 size={16} />}
            aria-haspopup="dialog"
            onClick={openColumns}
          />
        </Counted>

        {/* A plain link, so the browser downloads it and the export survives a
            closed tab. It carries the same filters the table is showing. An <a>
            rather than a button wrapping one: a <button> inside an <a> is nested
            interactive content, which assistive technology cannot resolve. */}
        <Tooltip label="Export this list as CSV">
          <a
            href={exportHref}
            download
            aria-label="Export this list as CSV"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-hs text-secondary no-underline transition-colors duration-150 hover:bg-fill-hover hover:text-body"
          >
            <Download size={16} aria-hidden="true" />
          </a>
        </Tooltip>

        {canWrite ? (
          <>
            <IconButton
              label="Save these filters and columns as a view"
              icon={<BookmarkPlus size={16} />}
              onClick={() => setShowSave(true)}
            />
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              Create {objectLabel.toLowerCase()}
            </Button>
          </>
        ) : null}
      </div>

      {showFilters ? (
        <FilterBuilder
          fields={filterFields}
          value={filters}
          onClose={() => setShowFilters(false)}
          onApply={(groups) => {
            setShowFilters(false)
            goTo({ filters: encodeFilters(groups) })
          }}
        />
      ) : null}

      <Modal open={showSave} title="Save this view" onClose={() => closeSave()}>
        <div className="flex flex-col gap-4">
          {viewId ? (
            <div className="flex flex-col gap-2 border-b border-divider pb-4">
              <p className="text-secondary">
                Overwrite “{viewLabel}” with the columns, filters and sort on screen. Everyone
                who uses that tab sees the change.
              </p>
              <div>
                <Button busy={saving} onClick={() => void writeView(viewId, viewLabel)}>
                  Update “{viewLabel}”
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-3">
            <p className="text-secondary">
              Or keep “{viewLabel}” as it is and save what is on screen under a new name. The
              name becomes the address, so the tab can be linked to.
            </p>
            <TextInput
              value={viewName}
              aria-label="New view name"
              placeholder="e.g. Enterprise in trial"
              onChange={(event) => setViewName(event.target.value)}
            />
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} />
              Everyone in this workspace can see it
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                busy={saving}
                disabled={viewName.trim() === ''}
                onClick={() => void writeView(null, viewName.trim())}
              >
                Save as new view
              </Button>
              <Button variant="tertiary" onClick={() => closeSave()}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={showColumns} size="lg" title="Edit columns" onClose={() => setShowColumns(false)}>
        <div className="flex flex-col gap-3">
          <p className="text-secondary">
            {draftColumns.length} of {allColumns.length} fields. The order here is the order
            across the table; the first column is the link into the record.
          </p>

          <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-hs border border-line p-2">
            {draftColumns.map((key, index) => (
              <div key={key} className="flex items-center gap-1">
                <Checkbox
                  className="min-w-0 flex-1"
                  checked
                  label={labelOf(key)}
                  onChange={() => setDraftColumns(draftColumns.filter((other) => other !== key))}
                />
                <IconButton
                  label={`Move ${labelOf(key)} earlier`}
                  icon={<ArrowUp aria-hidden="true" className="size-4" />}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                />
                <IconButton
                  label={`Move ${labelOf(key)} later`}
                  icon={<ArrowDown aria-hidden="true" className="size-4" />}
                  disabled={index === draftColumns.length - 1}
                  onClick={() => move(index, 1)}
                />
              </div>
            ))}
            {draftColumns.length === 0 ? (
              <p className="px-1 py-2 text-secondary">
                No columns yet. Add one below; a table needs at least one.
              </p>
            ) : null}
          </div>

          <div className="grid max-h-56 gap-1.5 overflow-y-auto rounded-hs border border-line p-2 @md:grid-cols-2">
            {allColumns
              .filter((field) => !draftColumns.includes(field.key))
              .map((field) => (
                <Checkbox
                  key={field.key}
                  checked={false}
                  label={field.label}
                  onChange={() => setDraftColumns([...draftColumns, field.key])}
                />
              ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={draftColumns.length === 0}
              onClick={() => {
                setShowColumns(false)
                goTo({ cols: draftColumns.join(',') })
              }}
            >
              Apply to this screen
            </Button>
            {canWrite && viewId ? (
              <Button
                busy={saving}
                disabled={draftColumns.length === 0}
                onClick={() => void writeView(viewId, viewLabel, draftColumns)}
              >
                Save to “{viewLabel}”
              </Button>
            ) : null}
            {params.cols ? (
              <Button variant="tertiary" onClick={() => { setShowColumns(false); goTo({ cols: undefined }) }}>
                Back to the view’s columns
              </Button>
            ) : null}
            <Button variant="tertiary" onClick={() => setShowColumns(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {showCreate ? (
        <CreateRecordDialog
          workspace={workspace}
          object={object}
          objectLabel={objectLabel}
          fields={createFields}
          onClose={() => {
            setShowCreate(false)
            // Drop ?new=1 so a refresh, or a step back, does not reopen it.
            if (askedToCreate) navigate(objectView(workspace, object, view, kind, params))
          }}
        />
      ) : null}
    </div>
  )
}
