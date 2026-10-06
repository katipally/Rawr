'use client'

import { Badge, Button, Checkbox, IconButton, Modal, Popover, TextInput, cn, useMounted, usePresence, useToast } from '@rawr/ui'
import { ArrowDown, ArrowUp, ArrowUpDown, BookmarkPlus, CalendarDays, ChevronDown, ChevronUp, Columns3, Settings, SlidersHorizontal, Search, Table2, X } from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useNavigation } from '~/components/navigation.tsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { FILTERS_DOCK } from '~/lib/docks.ts'
import { encodeFilters, objectView, type ListParams, type ViewKind } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useUi, useUiReady } from '~/lib/store/ui.ts'
import { typingInto } from '~/lib/typing-into.ts'
import { replaceParams } from '~/lib/url-params.ts'
import { FilterBuilder, type FilterField, type Group } from './filter-builder.tsx'
import { CreateRecordPanel, type CreateField } from './create-record.tsx'
import { QuickFilters } from './quick-filters.tsx'

export type ListToolbarProps = {
  account: string
  object: string
  objectLabel: string
  view: string
  viewId: string | null
  /** The version of that view as this page read it. */
  viewVersion: string | null
  kind: ViewKind
  /** Which shapes this object can be looked at in, decided by the page: a board
   *  needs a stage, a calendar needs a date field, and only the registry knows
   *  whether this object has either. */
  kinds: ViewKind[]
  params: ListParams
  filters: Group[]
  columns: string[]
  sorts: { key: string; direction: 'asc' | 'desc' }[]
  filterFields: FilterField[]
  createFields: CreateField[]
  canWrite: boolean
  /** Deep links: ?new=1 opens the create panel, ?view=new the save-view dialog.
   *  Read from the address on the server so it is there on first paint. */
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
  'inline-flex h-pill items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-4 py-2 text-small font-light text-body transition-all duration-150 ease-out hover:bg-fill'

/** Matches --rawr-duration-dock, which the panel's width transition runs for. */
const DOCK_EXIT_MS = 125

const KIND_LABEL: Record<ViewKind, string> = { list: 'Table view', board: 'Board view', calendar: 'Calendar view' }
const KIND_ICON: Record<ViewKind, typeof Table2> = { list: Table2, board: Columns3, calendar: CalendarDays }

export const ListToolbar = ({
  account,
  object,
  objectLabel,
  view,
  viewId,
  viewVersion,
  kind,
  kinds,
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
  const searchInput = useRef<HTMLInputElement>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const mounted = useMounted()
  const advanced = usePresence(showAdvanced && mounted, DOCK_EXIT_MS)
  const filtersDock = mounted ? document.getElementById(FILTERS_DOCK) : null
  const sortButton = useRef<HTMLButtonElement>(null)
  const [showSort, setShowSort] = useState(false)
  const headerCollapsed = useUi((state) => state.panelOpen.kpis) === false
  const setPanelOpen = useUi((state) => state.setPanelOpen)
  const headerOpen = !useUiReady() || !headerCollapsed
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

  // Derived from the prop, not seeded into state from it. `useState(x)` reads x
  // once, on the mount that creates the state -- so arriving by a client-side
  // navigation, which re-renders this component with openCreate now true rather
  // than remounting it, left the dialog shut while the address bar said it was
  // open. A deep link worked, because that mounts fresh, which is what made it
  // look like the menu item rather than the state was broken.
  //
  // Closing navigates the flag out of the URL, below, so there is nothing to
  // hold here: the address is the state, which is what the rest of this screen
  // already does with filters, sort and columns.
  const showCreate = askedToCreate
  // The view dialog has a second way in, the toolbar button, so it does keep a
  // local flag -- ORed with the URL rather than initialised from it.
  const [savePicked, setSavePicked] = useState(false)
  const showSave = askedForView || savePicked

  const [showColumns, setShowColumns] = useState(false)
  const [draftColumns, setDraftColumns] = useState(columns)
  // A column header's "Add column" asks for this dialog through the address,
  // since the table and the toolbar are siblings with nothing else in common.
  const columnsAsked = useSearchParams().get('columns') === 'edit'
  useEffect(() => {
    if (!columnsAsked) return
    replaceParams({ columns: null })
    setDraftColumns(columns)
    setShowColumns(true)
  }, [columnsAsked, columns])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      if (typingInto(event.target)) return
      event.preventDefault()
      searchInput.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!showAdvanced) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('[aria-modal="true"]')) setShowAdvanced(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showAdvanced])
  const [viewName, setViewName] = useState('')
  const [shared, setShared] = useState(true)
  const [saving, setSaving] = useState(false)

  const goTo = (next: ListParams) => {
    const merged: ListParams = { ...params, ...next }
    delete merged.page
    navigate(objectView(account, object, view, kind, merged))
  }

  const activeConditions = filters.reduce((sum, group) => sum + group.conditions.length, 0)
  const choices = Object.fromEntries(createFields.flatMap((field) => (field.choices ? [[field.key, field.choices]] : [])))
  const applyFilters = (groups: Group[]) => goTo({ filters: encodeFilters(groups) })

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
        expectedUpdatedAt: into ? viewVersion : null,
      })
      setSavePicked(false)
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
    setSavePicked(false)
    // Drop ?view=new so a refresh, or a step back, does not reopen it.
    if (askedForView) navigate(objectView(account, object, view, kind, params))
  }

  const labelOf = (key: string): string =>
    allColumns.find((field) => field.key === key)?.label ?? key

  const sortKey = sorts[0]?.key ?? ''
  const sortDirection = sorts[0]?.direction ?? 'desc'
  // What the table shows, plus whatever the view sorts by when that is not one
  // of them, so the select never claims a sort that is not the real one.
  const sortable = sortKey && !columns.includes(sortKey) ? [sortKey, ...columns] : columns

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
          className="relative w-full min-w-0 sm:w-[13.375rem]"
          onSubmit={(event) => {
            event.preventDefault()
            goTo({ q: search })
          }}
        >
          <TextInput
            ref={searchInput}
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
          <>
            <button
              ref={sortButton}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={showSort}
              onClick={() => setShowSort((open) => !open)}
              className={cn(pill, (showSort || params.sort) && 'bg-fill-hover')}
            >
              <ArrowUpDown aria-hidden="true" className="size-3.5" />
              Sort by
            </button>
            <Popover open={showSort} onClose={() => setShowSort(false)} anchorRef={sortButton} align="start" label="Sort by">
              <div className="flex w-[24.8125rem] max-w-[calc(100vw-2rem)] flex-col gap-3 p-4">
                <span className="text-small font-semibold">Sort by</span>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label="Property to sort by"
                    value={sortKey}
                    onChange={(event) => goTo({ sort: sortDirection === 'desc' ? `-${event.target.value}` : event.target.value })}
                    className="h-control min-w-0 flex-1 rounded-hs border border-line-strong bg-surface pl-3 text-body"
                  >
                    {sortKey ? null : <option value="">Choose a property</option>}
                    {sortable.map((key) => (
                      <option key={key} value={key}>
                        {labelOf(key)}
                      </option>
                    ))}
                  </select>
                  <fieldset className="flex h-control shrink-0 items-center rounded-pill border border-line p-0.5">
                    <legend className="sr-only">Sort direction</legend>
                    {(['desc', 'asc'] as const).map((direction) => (
                      <button
                        key={direction}
                        type="button"
                        aria-pressed={sortDirection === direction}
                        disabled={!sortKey}
                        onClick={() => goTo({ sort: direction === 'desc' ? `-${sortKey}` : sortKey })}
                        className="h-full rounded-pill border border-transparent px-3 text-small transition-all duration-150 ease-out hover:bg-fill disabled:cursor-not-allowed disabled:text-muted aria-pressed:border-line-strong aria-pressed:bg-surface aria-pressed:shadow-panel"
                      >
                        {direction === 'desc' ? 'Most recent' : 'Oldest'}
                      </button>
                    ))}
                  </fieldset>
                </div>
              </div>
            </Popover>
          </>
        ) : null}

        <span className="ml-auto flex items-center gap-1">
          {trailing}
          {kinds.length > 1 ? (
            <span className="flex h-control items-center rounded-pill border border-line p-0.5">
              {kinds.map((option) => {
                const Icon = KIND_ICON[option]
                return (
                  <Link
                    key={option}
                    href={objectView(account, object, view, option, { ...params, page: undefined })}
                    aria-current={kind === option ? 'true' : undefined}
                    aria-label={KIND_LABEL[option]}
                    title={KIND_LABEL[option]}
                    className={cn(
                      'grid h-full aspect-square place-items-center rounded-pill border text-body no-underline transition-all duration-150 ease-out',
                      kind === option ? 'border-line-strong bg-surface shadow-panel' : 'border-transparent hover:bg-fill',
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4" />
                  </Link>
                )
              })}
            </span>
          ) : null}
          {canWrite ? (
            <IconButton
              label={kind === 'list' ? 'Save these filters and columns as a view' : 'Save these filters as a view'}
              icon={<BookmarkPlus className="size-4" />}
              className="border border-line-strong text-body"
              onClick={() => setSavePicked(true)}
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
          {kind === 'list' ? (
            <IconButton
              label={headerOpen ? 'Collapse header' : 'Expand header'}
              icon={headerOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              className="border border-line-strong text-body"
              aria-expanded={headerOpen}
              onClick={() => setPanelOpen('kpis', !headerOpen)}
            />
          ) : null}
        </span>
      </div>

      {showFilters ? (
        <QuickFilters
          object={object}
          fields={filterFields}
          choices={choices}
          filters={filters}
          onChange={applyFilters}
          onAdvanced={() => setShowAdvanced(true)}
        />
      ) : null}

      {/* Docked beside the list rather than over it, and growing out of nothing,
          so the table reflows instead of being covered. A list too narrow to
          share lays it over the right edge instead. */}
      {advanced.present && filtersDock
        ? createPortal(
            <div
              data-closing={advanced.closing || undefined}
              className="w-[min(calc(var(--spacing-filters)+1rem),100cqw)] shrink-0 overflow-hidden transition-[width] duration-(--rawr-duration-dock) ease-dock starting:w-0 data-closing:w-0 motion-reduce:transition-none @max-dock:absolute @max-dock:inset-y-0 @max-dock:right-0 @max-dock:z-flyout"
            >
              <section
                aria-label="All filters"
                inert={advanced.closing}
                className="ml-4 flex h-full w-[min(var(--spacing-filters),calc(100cqw-1rem))] flex-col border-l border-line bg-surface @max-dock:shadow-overlay"
              >
                <header className="flex shrink-0 items-center gap-2 border-b border-line p-4">
                  <h2 className="min-w-0 flex-1 truncate text-lg font-normal">All filters</h2>
                  <IconButton
                    label="Close filters"
                    icon={<X aria-hidden="true" className="size-4" />}
                    onClick={() => setShowAdvanced(false)}
                    className="text-body"
                  />
                </header>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  <h3 className="mb-3 text-base font-semibold">Advanced filters</h3>
                  {/* Keyed by what is applied, so a quick filter changed while the
                      panel is open shows here rather than being overwritten. */}
                  <FilterBuilder
                    key={encodeFilters(filters)}
                    fields={filterFields}
                    value={filters}
                    onApply={applyFilters}
                    className="rounded-none border-0 p-0 shadow-none"
                  />
                </div>
              </section>
            </div>,
            filtersDock,
          )
        : null}

      <Modal
        open={showSave}
        title="Save this view"
        onClose={() => closeSave()}
        dirty={viewName !== ''}
        onSubmit={() => void writeView(null, viewName.trim())}
        footer={
          <>
            <Button variant="tertiary" onClick={() => closeSave()}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={saving} disabled={viewName.trim() === ''}>
              Save as new view
            </Button>
          </>
        }
      >
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
          </div>
        </div>
      </Modal>

      <Modal
        open={showColumns}
        size="lg"
        title="Edit columns"
        onClose={() => setShowColumns(false)}
        dirty={draftColumns.join() !== columns.join()}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setShowColumns(false)}>
              Cancel
            </Button>
            {params.cols ? (
              <Button variant="tertiary" onClick={() => { setShowColumns(false); goTo({ cols: undefined }) }}>
                Back to the view’s columns
              </Button>
            ) : null}
            {canWrite && viewId ? (
              <Button
                busy={saving}
                disabled={draftColumns.length === 0}
                onClick={() => void writeView(viewId, viewLabel, draftColumns)}
              >
                Save to “{viewLabel}”
              </Button>
            ) : null}
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
          </>
        }
      >
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
        </div>
      </Modal>

      {showCreate ? (
        <CreateRecordPanel
          account={account}
          object={object}
          objectLabel={objectLabel}
          fields={createFields}
          // Dropping ?new=1 is what closes it, since that flag is the only thing
          // holding it open. A refresh or a step back therefore cannot reopen it.
          onClose={() => navigate(objectView(account, object, view, kind, params))}
        />
      ) : null}
    </div>
  )
}
