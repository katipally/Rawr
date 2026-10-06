'use client'

import { Alert, Button, DataTable, DropdownMenu, EmptyState, Field, Modal, Select, Tabs, TextInput, cn, useToast, type Column } from '@rawr/ui'
import { ChevronDown, Search } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { AdminField, FieldType } from '@rawr/db'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import type { FilterField } from '~/components/crm/filter-builder.tsx'
import { ghostFilter } from '~/components/filter-chip.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { useFormat } from '~/components/zone.tsx'
import { propertiesPath } from '~/lib/links.ts'
import { api, errorMessage, trpc } from '~/lib/rpc.ts'
import { replaceParams, useUrlParam } from '~/lib/url-params.ts'
import { useQueryClient } from '@tanstack/react-query'
import { NEEDS_OPTIONS, PropertyEditor, TYPE_LABEL, type PropertyDraft } from './property-editor.tsx'

export type PropertyListProps = {
  object: string
  /** Every object the account has, for the object picker over the tabs. */
  objects: { key: string; label: string }[]
  rows: AdminField[]
  deleted: AdminField[]
  /** The denominator of the fill rate: how many records the object has now. */
  recordCount: number
  /** Every property of the object, as the filter builder wants them, so a
   *  conditional rule is written with the same control as every other filter. */
  filterFields: FilterField[]
  hub: string
  /** Every mutation on this screen is `field_def`, which dal/context.ts gives to
   *  the account hub alone. Rendering the controls for anybody else is four
   *  buttons that can only ever answer with a red toast. */
  canWrite: boolean
}

type Tab = 'properties' | 'groups' | 'archived'

const bulkAction =
  'inline-flex h-[calc(var(--spacing-row)-2px)] shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-body font-semibold transition-all duration-150 ease-out hover:bg-fill disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent'

const searchBox =
  'h-[2.5rem] w-full rounded-pill border border-line-strong bg-surface py-2 pr-10 pl-4 font-light placeholder:text-muted'

export const PropertyList = ({
  object,
  objects,
  rows,
  deleted,
  recordCount,
  filterFields,
  hub,
  canWrite,
}: PropertyListProps) => {
  const queryClient = useQueryClient()
  const fmt = useFormat()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const toast = useToast()
  const objectLabel = objects.find((entry) => entry.key === object)?.label ?? object

  const [tabParam] = useUrlParam('tab')
  const tab: Tab = tabParam === 'groups' || (tabParam === 'archived' && canWrite) ? tabParam : 'properties'
  const [action, setAction] = useUrlParam('action')
  const creating = canWrite && action === 'create'
  const [editId, setEditId] = useUrlParam('edit')
  const editing = canWrite ? (rows.find((field) => field.id === editId && !field.isSystem) ?? null) : null
  const closeEditor = () => replaceParams({ action: null, edit: null, section: null })
  const [group, setGroup] = useUrlParam('group')
  const [typeFilter, setTypeFilter] = useUrlParam('ftype')

  const [removing, setRemoving] = useState<AdminField | null>(null)
  const [usage, setUsage] = useState<{ filled: number } | null>(null)
  const [grouping, setGrouping] = useState<{ name: string; rename: boolean } | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [purging, setPurging] = useState<AdminField | null>(null)
  const [busy, setBusy] = useState(false)
  /** A portal arrives with three hundred and seventy-two properties on contacts
   *  alone, so the list is searched as it is typed into. */
  const [query, setQuery] = useState('')

  const [renamed, setRenamed] = useState<{ from: string; to: string } | null>(null)

  // Dropped the moment the server's own rows agree, so the overlay can never
  // outlive the answer it was standing in for.
  useEffect(() => {
    if (renamed && !rows.some((field) => field.groupName === renamed.from)) setRenamed(null)
  }, [rows, renamed])

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast('success', done)
      router.refresh()
      return true
    } catch (cause) {
      toast('error', errorMessage(cause))
      return false
    } finally {
      setBusy(false)
    }
  }

  const save = async (draft: PropertyDraft) => {
    const field = editing
    const ok = await run(
      () =>
        field
          ? api.admin.fields.update.mutate({
              id: field.id,
              label: draft.label,
              ...(NEEDS_OPTIONS.has(field.type) ? { options: draft.options } : {}),
              helpText: draft.helpText,
              groupName: draft.groupName,
              conditional: draft.conditional,
              isRequired: draft.isRequired,
              trackChanges: draft.trackChanges,
            })
          : api.admin.fields.create.mutate({
              object,
              key: draft.key,
              label: draft.label,
              type: draft.type,
              ...(NEEDS_OPTIONS.has(draft.type) ? { options: draft.options } : {}),
              helpText: draft.helpText,
              groupName: draft.groupName,
              conditional: draft.conditional,
              isRequired: draft.isRequired,
              trackChanges: draft.trackChanges,
            }),
      field ? 'Property saved.' : 'Property created. It is on the record editor now.',
    )
    if (ok) closeEditor()
  }

  const openRemove = async (field: AdminField) => {
    setRemoving(field)
    setUsage(null)
    try {
      setUsage(await queryClient.fetchQuery({ ...trpc.admin.fields.usage.queryOptions({ id: field.id }), staleTime: 0 }))
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const move = (index: number, by: number) => {
    const next = [...rows]
    const target = index + by
    if (target < 0 || target >= next.length) return
    const [moved] = next.splice(index, 1)
    if (moved) next.splice(target, 0, moved)
    void run(
      () => api.admin.fields.reorder.mutate({ object, orderedIds: next.map((field) => field.id) }),
      'Order saved.',
    )
  }

  /** A rename the server has been told about and has not been read back yet.
   *  Without it the group filter keeps the old name until the refresh lands,
   *  with the group just renamed selected and not in it. */
  const groupOf = (field: AdminField): string | null =>
    field.groupName && renamed?.from === field.groupName ? renamed.to : field.groupName

  // One pass over the rows for every group's count: O(n) rather than a filter per group.
  const counts = new Map<string, number>()
  for (const field of rows) {
    const name = groupOf(field) ?? ''
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const groups = [...counts.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b))
  const types = [...new Set(rows.map((field) => field.type))].sort((a, b) => TYPE_LABEL[a].localeCompare(TYPE_LABEL[b]))

  const needle = query.trim().toLowerCase()
  const visible = rows.filter(
    (field) =>
      (!group || (group === 'ungrouped' ? !groupOf(field) : groupOf(field) === group)) &&
      (!typeFilter || field.type === typeFilter) &&
      (needle === '' ||
        field.label.toLowerCase().includes(needle) ||
        field.key.includes(needle) ||
        (field.helpText ?? '').toLowerCase().includes(needle)),
  )
  /** Reordering writes the whole ordered id list, so it can only be offered when
   *  the whole list is on screen. */
  const filtered = visible.length !== rows.length
  const { page, pager, offset } = usePagedRows(visible, 'properties')

  const tabHref = (key: Tab) => {
    const next = new URLSearchParams(params)
    for (const name of ['tab', 'skip', 'group', 'ftype']) next.delete(name)
    if (key !== 'properties') next.set('tab', key)
    const search = next.toString()
    return `${pathname}${search ? `?${search}` : ''}`
  }

  const sourceOf = (field: AdminField) =>
    !field.isCustom || field.isSystem ? 'Rawr' : field.source ? `Import: ${field.source}` : 'Custom'

  const columns: Column<AdminField>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 420,
      render: (field) => {
        const index = offset + page.indexOf(field)
        const notes = [
          TYPE_LABEL[field.type],
          field.isRequired ? 'Required' : null,
          field.isHot ? `Indexed${field.indexState ? ` (${field.indexState})` : ''}` : null,
          field.conditional ? 'Conditional' : null,
          field.trackChanges ? 'On the timeline' : null,
        ].filter(Boolean)
        const editable = canWrite && !field.isSystem
        return (
          <span className="flex min-w-0 items-center gap-2 py-1">
            <span className="flex min-w-0 flex-1 flex-col">
              {editable ? (
                <button type="button" title={field.label} onClick={() => setEditId(field.id)} className="truncate text-left font-semibold text-link hover:underline">
                  {field.label}
                </button>
              ) : (
                <span title={field.label} className="truncate font-semibold">{field.label}</span>
              )}
              <span title={notes.join(' · ')} className="truncate text-small font-light text-secondary">{notes.join(' · ')}</span>
            </span>
            {canWrite ? (
              <RowActions>
                <DropdownMenu
                  label={`More for ${field.label}`}
                  align="start"
                  trigger={(props) => (
                    <button {...props} type="button" className={rowPill}>
                      More
                      <ChevronDown aria-hidden="true" className="size-3" />
                    </button>
                  )}
                  groups={[
                    {
                      key: 'field',
                      items: [
                        ...(editable ? [{ key: 'edit', label: 'Edit', onSelect: () => setEditId(field.id) }] : []),
                        ...(editable ? [{ key: 'usage', label: 'Used in', onSelect: () => replaceParams({ edit: field.id, section: 'usage' }) }] : []),
                        ...(filtered
                          ? []
                          : [
                              { key: 'up', label: 'Move up', disabled: busy || index === 0, onSelect: () => move(index, -1) },
                              { key: 'down', label: 'Move down', disabled: busy || index === rows.length - 1, onSelect: () => move(index, 1) },
                            ]),
                        // "Index it" keeps its words: it is a decision about cost and
                        // speed, not a routine row action.
                        ...(field.isCustom && field.storage === 'jsonb' && !field.isHot
                          ? [
                              {
                                key: 'index',
                                label: 'Index it',
                                disabled: busy,
                                onSelect: () =>
                                  void run(
                                    () => api.admin.fields.promoteToHot.mutate({ fieldId: field.id }),
                                    'Index requested. The worker builds it within the minute.',
                                  ),
                              },
                            ]
                          : []),
                      ],
                    },
                    ...(field.isCustom && field.storage === 'jsonb'
                      ? [{ key: 'danger', items: [{ key: 'archive', label: 'Archive', destructive: true, onSelect: () => void openRemove(field) }] }]
                      : []),
                  ]}
                />
              </RowActions>
            ) : null}
          </span>
        )
      },
    },
    { key: 'group', header: 'Group', width: 260, render: (field) => <span title={groupOf(field) ?? undefined} className="block truncate font-light">{groupOf(field) ?? EMPTY_VALUE}</span> },
    { key: 'source', header: 'Created by', width: 200, render: (field) => <span title={sourceOf(field)} className="block truncate font-light">{sourceOf(field)}</span> },
    {
      key: 'fill',
      header: 'Fill Rate',
      width: 120,
      align: 'right',
      render: (field) => (
        <span
          title={field.filledAt ? `${fmt.number(field.filledCount ?? 0)} of ${fmt.number(recordCount)}, as of ${fmt.date(field.filledAt)}` : 'Not measured yet'}
          className="font-light tabular-nums"
        >
          {field.filledCount === null || recordCount === 0 ? EMPTY_VALUE : fmt.percent(field.filledCount / recordCount)}
        </span>
      ),
    },
  ]

  const groupRows = [...groups.map((name) => ({ name, label: name })), ...(counts.has('') ? [{ name: 'ungrouped', label: 'Ungrouped' }] : [])]
  const groupColumns: Column<(typeof groupRows)[number]>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 520,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <button
            type="button"
            title={row.label}
            onClick={() => replaceParams({ tab: null, group: row.name, ftype: null, skip: null })}
            className="min-w-0 flex-1 truncate text-left font-light hover:underline"
          >
            {row.label}
          </button>
          {canWrite && row.name !== 'ungrouped' ? (
            <RowActions>
              <button
                type="button"
                className={rowPill}
                onClick={() => {
                  setGrouping({ name: row.name, rename: true })
                  setGroupDraft(row.name)
                }}
              >
                Rename
              </button>
            </RowActions>
          ) : null}
        </span>
      ),
    },
    { key: 'count', header: 'Number of properties', width: 200, align: 'right', render: (row) => <span className="font-light tabular-nums">{fmt.number(counts.get(row.name === 'ungrouped' ? '' : row.name) ?? 0)}</span> },
  ]

  const archivedColumns: Column<AdminField>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 420,
      render: (field) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-1 flex-col">
            <span title={field.label} className="truncate font-semibold">{field.label}</span>
            <code title={field.key} className="truncate text-small text-secondary">{field.key}</code>
          </span>
          <RowActions>
            <button type="button" className={rowPill} disabled={busy} onClick={() => void run(() => api.admin.fields.restore.mutate({ id: field.id }), 'Restored.')}>
              Restore
            </button>
            <button type="button" className={cn(rowPill, 'text-error')} onClick={() => setPurging(field)}>
              Purge
            </button>
          </RowActions>
        </span>
      ),
    },
    { key: 'type', header: 'Field type', width: 220, render: (field) => <span className="block truncate font-light">{TYPE_LABEL[field.type]}</span> },
    { key: 'group', header: 'Group', width: 260, render: (field) => <span title={field.groupName ?? undefined} className="block truncate font-light">{field.groupName ?? EMPTY_VALUE}</span> },
  ]

  const typeName = (key: string | null) => (key && key in TYPE_LABEL ? TYPE_LABEL[key as FieldType] : null)
  const groupName = group === 'ungrouped' ? 'Ungrouped' : group

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-line px-4 py-4 sm:px-5">
        <label className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2">
          <span className="text-base font-semibold">Select an object:</span>
          <Select
            value={object}
            onChange={(event) => router.push(propertiesPath(event.target.value))}
            className="w-64 max-w-full"
          >
            {objects.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label} properties
              </option>
            ))}
          </Select>
        </label>
      </div>

      <Tabs
        label="Property views"
        onSelect={(key) => replaceParams({ tab: key === 'properties' ? null : key, skip: null })}
        items={[
          { key: 'properties', label: `Properties (${fmt.number(rows.length)})`, href: tabHref('properties'), current: tab === 'properties' },
          { key: 'groups', label: 'Groups', href: tabHref('groups'), current: tab === 'groups' },
          ...(canWrite ? [{ key: 'archived', label: `Archived (${fmt.number(deleted.length)})`, href: tabHref('archived'), current: tab === 'archived' }] : []),
        ]}
      />

      {tab === 'properties' ? (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <DropdownMenu
              label="Filter by group"
              align="start"
              trigger={(props) => (
                <button {...props} type="button" className={cn(ghostFilter, 'text-body', group && 'bg-fill-hover')}>
                  <span className="max-w-64 truncate">{groupName ?? 'All groups'}</span>
                  <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                </button>
              )}
              groups={[
                {
                  key: 'groups',
                  items: [
                    { key: '', label: 'All groups', checked: !group, onSelect: () => replaceParams({ group: null, skip: null }) },
                    ...groups.map((name) => ({ key: name, label: name, checked: group === name, onSelect: () => replaceParams({ group: name, skip: null }) })),
                    ...(counts.has('') ? [{ key: 'ungrouped', label: 'Ungrouped', checked: group === 'ungrouped', onSelect: () => replaceParams({ group: 'ungrouped', skip: null }) }] : []),
                  ],
                },
              ]}
            />
            <DropdownMenu
              label="Filter by field type"
              align="start"
              trigger={(props) => (
                <button {...props} type="button" className={cn(ghostFilter, 'text-body', typeFilter && 'bg-fill-hover')}>
                  <span className="max-w-64 truncate">{typeName(typeFilter) ?? 'All field types'}</span>
                  <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                </button>
              )}
              groups={[
                {
                  key: 'types',
                  items: [
                    { key: '', label: 'All field types', checked: !typeFilter, onSelect: () => setTypeFilter(null) },
                    ...types.map((name) => ({ key: name, label: TYPE_LABEL[name], checked: typeFilter === name, onSelect: () => replaceParams({ ftype: name, skip: null }) })),
                  ],
                },
              ]}
            />
            {group || typeFilter ? (
              <Button variant="tertiary" onClick={() => replaceParams({ group: null, ftype: null, skip: null })}>
                Reset filters
              </Button>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="relative w-full min-w-0 sm:w-[24rem]">
              <span className="sr-only">Search properties</span>
              <input type="search" value={query} placeholder="Search properties" onChange={(event) => setQuery(event.target.value)} className={searchBox} />
              <Search aria-hidden="true" className="absolute top-1/2 right-4 size-4 -translate-y-1/2" />
            </label>
            {canWrite ? (
              <Button onClick={() => setAction('create')}>Create property</Button>
            ) : (
              <p className="text-secondary">You need {hub} access to change the properties.</p>
            )}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title={rows.length === 0 ? 'No properties yet' : 'No property matches'}
              description={rows.length === 0 ? `Create a property to store something about every ${objectLabel.toLowerCase()} record.` : 'Try another name, or reset the filters.'}
            />
          ) : (
            <DataTable
              columns={columns}
              rows={page}
              rowKey={(field) => field.id}
              caption={`${objectLabel} properties`}
              storageKey="settings.properties"
              {...(canWrite
                ? {
                    selection: { selected: picked, onChange: setPicked, noun: 'property' },
                    headerBar:
                      picked.size > 0 ? (
                        // A group is the name on the properties in it, so making one
                        // and moving properties into it are the same act.
                        <div
                          role="toolbar"
                          aria-label={`Actions for ${fmt.number(picked.size)} selected properties`}
                          className="flex h-full min-w-0 animate-drop-in items-center gap-1 rounded-hs border border-line bg-surface pl-4 motion-reduce:animate-none"
                        >
                          <span className="mr-3 min-w-0 shrink truncate font-semibold">{fmt.number(picked.size)} selected</span>
                          <Select
                            aria-label="Move the selected properties to a group"
                            value=""
                            disabled={busy}
                            onChange={(event) => {
                              const name = event.target.value
                              if (!name) return
                              void run(
                                () => api.admin.fields.moveToGroup.mutate({ object, fieldIds: [...picked], groupName: name === 'ungrouped' ? null : name }),
                                'Moved.',
                              ).then((ok) => ok && setPicked(new Set()))
                            }}
                            className="h-control min-h-0 w-auto min-w-40"
                          >
                            <option value="">Move to group...</option>
                            {groups.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                            <option value="ungrouped">Ungrouped</option>
                          </Select>
                          <button
                            type="button"
                            className={bulkAction}
                            onClick={() => {
                              setGrouping({ name: '', rename: false })
                              setGroupDraft('')
                            }}
                          >
                            Create group
                          </button>
                        </div>
                      ) : undefined,
                  }
                : {})}
            />
          )}
          {pager}
        </>
      ) : null}

      {tab === 'groups' ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0">Properties are stored in groups so that you can keep them organized.</p>
            {canWrite ? (
              <Button
                onClick={() => {
                  setGrouping({ name: '', rename: false })
                  setGroupDraft('')
                }}
              >
                Create group
              </Button>
            ) : null}
          </div>
          {groupRows.length === 0 ? (
            <EmptyState title="No groups yet" description="A group is made by moving properties into it." />
          ) : (
            <DataTable columns={groupColumns} rows={groupRows} rowKey={(row) => row.name} caption="Property groups" storageKey="settings.property-groups" />
          )}
        </>
      ) : null}

      {tab === 'archived' ? (
        <>
          <p className="min-w-0">
            Archived properties are hidden everywhere with their data untouched. Restore puts one back exactly as it was.
            Purging strips the value out of every record and cannot be undone.
          </p>
          {deleted.length === 0 ? (
            <EmptyState title="No archived properties" description="A property you archive waits here until it is restored or purged." />
          ) : (
            <DataTable columns={archivedColumns} rows={deleted} rowKey={(field) => field.id} caption="Archived properties" storageKey="settings.properties-archived" />
          )}
        </>
      ) : null}

      {creating || editing ? (
        <PropertyEditor
          key={editing?.id ?? 'new'}
          field={editing}
          objectLabel={objectLabel}
          groups={groups}
          filterFields={filterFields}
          recordCount={recordCount}
          busy={busy}
          onSave={(draft) => void save(draft)}
          onClose={closeEditor}
        />
      ) : null}

      <Modal
        open={removing !== null}
        size="sm"
        title={`Archive ${removing?.label ?? ''}`}
        onClose={() => setRemoving(null)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() => {
                const field = removing
                if (!field) return
                void run(() => api.admin.fields.remove.mutate({ id: field.id }), 'Archived. The data is still there.').then(
                  (ok) => ok && setRemoving(null),
                )
              }}
            >
              Archive property
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p>
            The property disappears from every screen immediately.{' '}
            {usage === null
              ? 'Counting how many records hold a value...'
              : usage.filled === 0
                ? 'No record holds a value for it.'
                : `${fmt.number(usage.filled)} record${usage.filled === 1 ? '' : 's'} hold a value, and every one of those values stays exactly where it is.`}
          </p>
          <p className="text-secondary">
            Nothing is lost here. Restoring it from Archived puts it back. Purging, which is a separate action, is
            what actually removes the data.
          </p>
        </div>
      </Modal>

      <Modal
        open={purging !== null}
        size="sm"
        title={`Purge ${purging?.label ?? ''}`}
        onClose={() => setPurging(null)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setPurging(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() => {
                const field = purging
                if (!field) return
                void run(async () => {
                  const result = await api.admin.fields.purge.mutate({ id: field.id })
                  toast('info', `${fmt.number(result.stripped)} records had the value stripped.`)
                }, 'Purged.').then((ok) => ok && setPurging(null))
              }}
            >
              Purge permanently
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Alert>
            This strips <code>{purging?.key}</code> out of every record in the account and removes
            the definition. It cannot be undone and there is no copy anywhere else.
          </Alert>
        </div>
      </Modal>

      <Modal
        open={grouping !== null}
        size="sm"
        title={grouping?.rename ? `Rename ${grouping.name}` : 'Create group'}
        onClose={() => setGrouping(null)}
        onSubmit={() => {
          if (!grouping) return
          const target = grouping
          const name = groupDraft.trim()
          void run(
            () =>
              target.rename
                ? api.admin.fields.renameGroup.mutate({ object, from: target.name, to: name })
                : api.admin.fields.moveToGroup.mutate({
                    object,
                    fieldIds: [...picked],
                    groupName: name,
                  }),
            target.rename ? 'Group renamed.' : 'Group created.',
          ).then((ok) => {
            if (!ok) return
            if (target.rename) setRenamed({ from: target.name, to: name })
            setGrouping(null)
            setPicked(new Set())
            if (!target.rename) setGroup(name)
          })
        }}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setGrouping(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!groupDraft.trim() || (!grouping?.rename && picked.size === 0)}>
              {grouping?.rename ? 'Rename group' : 'Create group'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field id="group-name" label="Name">
            <TextInput
              id="group-name"
              value={groupDraft}
              onChange={(event) => setGroupDraft(event.target.value)}
              autoFocus
            />
          </Field>
          {grouping && !grouping.rename ? (
            <p className="text-secondary">
              {picked.size === 0
                ? 'A group is the name on the properties in it, so it needs properties to exist. Tick the ones that belong in it on the Properties tab first.'
                : `The ${fmt.number(picked.size)} selected propert${picked.size === 1 ? 'y moves' : 'ies move'} into it.`}
            </p>
          ) : null}
        </div>
      </Modal>
    </div>
  )
}
