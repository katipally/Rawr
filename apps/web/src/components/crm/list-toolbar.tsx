'use client'

import { Button, Modal, TextInput, useToast } from '@rawr/ui'
import { useNavigation } from '~/components/navigation.tsx'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { encodeFilters, objectView, type ListParams } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { FilterBuilder, type FilterField, type Group } from './filter-builder.tsx'
import { CreateRecordDialog, type CreateField } from './create-record.tsx'

export type ListToolbarProps = {
  workspace: string
  object: ObjectKey
  objectLabel: string
  view: string
  viewId: string | null
  kind: 'list' | 'board'
  params: ListParams
  filters: Group[]
  columns: string[]
  sorts: { key: string; direction: 'asc' | 'desc' }[]
  filterFields: FilterField[]
  createFields: CreateField[]
  canWrite: boolean
  exportHref: string
}

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
  exportHref,
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
  useEffect(() => {
    if (askedToCreate && canWrite) setShowCreate(true)
  }, [askedToCreate, canWrite])
  const [viewName, setViewName] = useState('')
  const [shared, setShared] = useState(true)
  const [saving, setSaving] = useState(false)

  const goTo = (next: ListParams) => {
    const merged: ListParams = { ...params, ...next }
    delete merged.cursor
    navigate(objectView(workspace, object, view, kind, merged))
  }

  const activeConditions = filters.reduce((sum, group) => sum + group.conditions.length, 0)

  const saveView = async () => {
    setSaving(true)
    try {
      const saved = await api.crm.views.save.mutate({
        object,
        id: viewId,
        name: viewName.trim(),
        kind: kind === 'board' ? 'board' : 'table',
        columns,
        filters: filters as never,
        sorts,
        isShared: shared,
      })
      toast('success', `Saved as “${saved.name}”. Its address is /views/${saved.slug}/${kind}.`)
      setShowSave(false)
      navigate(objectView(workspace, object, saved.slug, kind, { q: params.q }))
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setSaving(false)
    }
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
          <Button type="submit" className="shrink-0">
            Search
          </Button>
          {params.q ? (
            <Button variant="tertiary" onClick={() => { setSearch(''); goTo({ q: undefined }) }}>
              Clear
            </Button>
          ) : null}
        </form>

        <Button onClick={() => setShowFilters((open) => !open)} aria-expanded={showFilters}>
          Filters{activeConditions > 0 ? ` (${activeConditions})` : ''}
        </Button>

        {/* A plain link, so the browser downloads it and the export survives a
            closed tab. It carries the same filters the table is showing. Styled
            as a button rather than wrapping one: a <button> inside an <a> is
            nested interactive content, which assistive technology cannot resolve. */}
        <a
          href={exportHref}
          download
          className="inline-flex min-h-9 items-center justify-center rounded-hs border border-line bg-surface px-3 py-1.5 font-medium text-body no-underline transition-colors duration-150 hover:border-line-pressed hover:bg-fill-hover"
        >
          Export CSV
        </a>

        {canWrite ? (
          <>
            <Button onClick={() => setShowSave(true)}>Save as view</Button>
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

      <Modal open={showSave} title="Save this view" onClose={() => setShowSave(false)}>
        <div className="flex flex-col gap-3">
          <p className="text-secondary">
            Saves the current columns, filters and sort under a name. The name becomes the
            address, so the tab can be linked to.
          </p>
          <TextInput
            value={viewName}
            aria-label="View name"
            placeholder="e.g. Enterprise in trial"
            onChange={(event) => setViewName(event.target.value)}
          />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={shared} onChange={(event) => setShared(event.target.checked)} />
            Everyone in this workspace can see it
          </label>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={saving} disabled={viewName.trim() === ''} onClick={() => void saveView()}>
              Save view
            </Button>
            <Button variant="tertiary" onClick={() => setShowSave(false)}>
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
