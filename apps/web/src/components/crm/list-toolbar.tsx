'use client'

import { Badge, Button, Checkbox, DropdownMenu, IconButton, Modal, TextInput, cn, useToast } from '@rawr/ui'
import { ArrowDown, ArrowUp, ArrowUpDown, BookmarkPlus, ChevronDown, Settings, SlidersHorizontal, Search, X } from 'lucide-react'
import { useNavigation } from '~/components/navigation.tsx'
import { useState, type ReactNode } from 'react'
import type { ObjectKey } from '@rawr/db'
import { encodeFilters, objectView, type ListParams, type ViewKind } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { FilterBuilder, type FilterField, type Group } from './filter-builder.tsx'
import { CreateRecordDialog, type CreateField } from './create-record.tsx'

export type ListToolbarProps = {
  account: string
  object: string
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
  /** Deep links: ?new=1 opens the create dialog, ?view=new the save-view one.
   *  Read from the address on the server so the dialog is there on first paint. */
  openCreate?: boolean
  openView?: boolean
  /** The view's own name, so "update this view" can save without renaming it. */
  viewLabel: string
  /** Every field the object has, for the column chooser. Ordered as the registry
   *  orders them, which is the order a person sees on the record page. */
  allColumns: { key: string; label: string }[]
  /** Sits at the right of the row, before the column and view controls: the
   *  board's pipeline picker. */
  trailing?: ReactNode
}

const pill =
  'inline-flex h-control items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-4 text-small font-light text-body hover:bg-fill'

export const ListToolbar = ({
  account,
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
  openCreate = false,
  openView = false,
  viewLabel,
  allColumns,
  trailing,
}: ListToolbarProps) => {
  const { navigate } = useNavigation()
  const toast = useToast()
  const [search, setSearch] = useState(params.q ?? '')
  const [showFilters, setShowFilters] = useState(false)
  // The + in the top bar links here with ?new=1, and "Add view" on the tab bar
  // with ?view=new, rather than either carrying its own copy of a dialog: there
  // is one create form per object and it always knows the object's real fields.
  //
  // Read on the server and passed in, not from useSearchParams in an effect. A
  // deep link has to open the dialog on the first paint; an effect opens it only
  // once React has hydrated, which on a slow page is late enough to look broken
  // and is a race against anything that remounts the toolbar in between.
  const askedToCreate = openCreate && canWrite
  const askedForView = openView && canWrite
  const [showSave, setShowSave] = useState(askedForView)
  const [showCreate, setShowCreate] = useState(askedToCreate)

  const [showColumns, setShowColumns] = useState(false)
  const [draftColumns, setDraftColumns] = useState(columns)
  const [viewName, setViewName] = useState('')
  const [shared, setShared] = useState(true)
  const [saving, setSaving] = useState(false)

  const goTo = (next: ListParams) => {
    const merged: ListParams = { ...params, ...next }
    delete merged.cursor
    navigate(objectView(account, object, view, kind, merged))
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
        navigate(objectView(account, object, saved.slug, kind, { ...params, cols: undefined }))
      } else {
        toast('success', `Saved as “${saved.name}”. Its address is /views/${saved.slug}/${kind}.`)
        navigate(objectView(account, object, saved.slug, kind, { q: params.q }))
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
    if (askedForView) navigate(objectView(account, object, view, kind, params))
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
          className="relative w-full min-w-0 sm:w-56"
          onSubmit={(event) => {
            event.preventDefault()
            goTo({ q: search })
          }}
        >
          <TextInput
            type="search"
            value={search}
            aria-label={`Search ${objectLabel.toLowerCase()}`}
            placeholder="Search ( / )"
            onChange={(event) => setSearch(event.target.value)}
            className="h-control min-h-0 rounded-pill border-line-strong bg-surface py-1 pr-10 pl-4"
          />
          <button
            type="submit"
            aria-label={`Search ${objectLabel.toLowerCase()}`}
            className="absolute top-1/2 right-1 grid size-6 -translate-y-1/2 place-items-center rounded-pill text-body hover:bg-fill"
          >
            <Search aria-hidden="true" className="size-4" />
          </button>
          {params.q ? (
            <button
              type="button"
              aria-label="Clear the search"
              onClick={() => { setSearch(''); goTo({ q: undefined }) }}
              className="absolute top-1/2 right-7 grid size-6 -translate-y-1/2 place-items-center rounded-pill text-body hover:bg-fill"
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          ) : null}
        </form>

        <button
          type="button"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((open) => !open)}
          className={cn(pill, (showFilters || activeConditions > 0) && 'bg-fill-hover')}
        >
          <SlidersHorizontal aria-hidden="true" className="size-3.5" />
          Filter
          {activeConditions > 0 ? <Badge tone="neutral">{activeConditions}</Badge> : null}
        </button>

        {kind === 'list' ? (
        <DropdownMenu
          label="Sort by"
          align="start"
          groups={[
            {
              key: 'sort',
              items: columns.map((key) => {
                const active = sorts[0]?.key === key
                // Choosing the sorted column flips it; choosing another starts
                // descending, which is what a person wants from a date or an amount.
                const direction = active && sorts[0]?.direction === 'desc' ? 'asc' : 'desc'
                return {
                  key,
                  label: labelOf(key),
                  checked: active,
                  hint: active ? (sorts[0]?.direction === 'desc' ? 'Descending' : 'Ascending') : undefined,
                  onSelect: () => goTo({ sort: direction === 'desc' ? `-${key}` : key }),
                }
              }),
            },
          ]}
          trigger={(props) => (
            <button {...props} type="button" className={cn(pill, sorts.length > 0 && params.sort && 'bg-fill-hover')}>
              <ArrowUpDown aria-hidden="true" className="size-3.5" />
              Sort by
              {sorts[0] ? <span className="text-secondary">{labelOf(sorts[0].key)}</span> : null}
              <ChevronDown aria-hidden="true" className="size-3" />
            </button>
          )}
        />
        ) : null}

        <span className="ml-auto flex items-center gap-1">
          {trailing}
          {canWrite ? (
            <IconButton
              label={kind === 'list' ? 'Save these filters and columns as a view' : 'Save these filters as a view'}
              icon={<BookmarkPlus className="size-4" />}
              className="border border-line-strong text-body"
              onClick={() => setShowSave(true)}
            />
          ) : null}
          {kind === 'list' ? (
            <IconButton
              label={`Edit columns (${columns.length} shown)`}
              icon={<Settings className="size-4" />}
              className="border border-line-strong text-body"
              aria-haspopup="dialog"
              onClick={openColumns}
            />
          ) : null}
        </span>
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
              Everyone in this account can see it
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
          account={account}
          object={object}
          objectLabel={objectLabel}
          fields={createFields}
          onClose={() => {
            setShowCreate(false)
            // Drop ?new=1 so a refresh, or a step back, does not reopen it.
            if (askedToCreate) navigate(objectView(account, object, view, kind, params))
          }}
        />
      ) : null}
    </div>
  )
}
