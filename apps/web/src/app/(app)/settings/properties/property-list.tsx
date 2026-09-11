'use client'

import { Alert, Button, Field, IconButton, Modal, Select, TextArea, TextInput, cn, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import type { AdminField, Conditional, FieldType } from '@rawr/db'
import { FilterBuilder, type FilterField, type Group } from '~/components/crm/filter-builder.tsx'
import { ACTION_ICONS } from '~/components/icons.ts'
import { usePagedRows } from '~/components/paged.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

export type PropertyListProps = {
  object: string
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

/** Field types that need a list of choices, and the types a person actually reaches
 *  for. The registry knows all twenty; offering them in the order somebody thinks
 *  about them is a UI decision, so it lives here. */
const TYPE_GROUPS: { label: string; types: FieldType[] }[] = [
  { label: 'Text', types: ['text', 'long_text', 'rich_text', 'email', 'phone', 'url', 'linkedin', 'address'] },
  { label: 'Numbers', types: ['number', 'currency', 'percent', 'rating'] },
  { label: 'Choices', types: ['select', 'multi_select', 'boolean'] },
  { label: 'Dates', types: ['date', 'datetime'] },
  { label: 'Other', types: ['user', 'relation', 'json'] },
]

const NEEDS_OPTIONS = new Set<FieldType>(['select', 'multi_select'])

/** A key is generated from the label once and then never changes, because renaming
 *  a label must never touch stored data. F0 §4. */
const keyFrom = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f_$1')
    .slice(0, 59)

export const PropertyList = ({
  object,
  rows,
  deleted,
  recordCount,
  filterFields,
  hub,
  canWrite,
}: PropertyListProps) => {
  const router = useRouter()
  const toast = useToast()

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AdminField | null>(null)
  const [removing, setRemoving] = useState<AdminField | null>(null)
  const [usage, setUsage] = useState<{ filled: number; usedIn: { kind: string; name: string }[] } | null>(null)
  /** Which row has its "Used in" open, and what came back. Loaded on the click,
   *  because asking for all three hundred and seventy-two at once is three
   *  hundred and seventy-two queries nobody read. */
  const [openUse, setOpenUse] = useState<string | null>(null)
  const [uses, setUses] = useState<Record<string, { kind: string; name: string }[]>>({})
  const [grouping, setGrouping] = useState<{ name: string; rename: boolean } | null>(null)
  const [groupDraft, setGroupDraft] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [purging, setPurging] = useState<AdminField | null>(null)
  const [busy, setBusy] = useState(false)

  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [type, setType] = useState<FieldType>('text')
  const [options, setOptions] = useState('')
  const [helpText, setHelpText] = useState('')
  const [groupName, setGroupName] = useState('')
  const [isRequired, setIsRequired] = useState(false)
  const [trackChanges, setTrackChanges] = useState(false)
  const [conditional, setConditional] = useState<Conditional | null>(null)

  /** A portal arrives with three hundred and seventy-two properties on contacts
   *  alone. A flat list of that many, reordered a click at a time, is a list
   *  nobody opens twice. */
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('')

  const reset = () => {
    setLabel('')
    setKey('')
    setKeyTouched(false)
    setType('text')
    setOptions('')
    setHelpText('')
    setGroupName('')
    setIsRequired(false)
    setTrackChanges(false)
    setConditional(null)
  }

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

  const optionList = () =>
    options
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)

  const create = async () => {
    const ok = await run(
      () =>
        api.admin.fields.create.mutate({
          object,
          key: keyTouched ? key : keyFrom(label),
          label,
          type,
          ...(NEEDS_OPTIONS.has(type) ? { options: optionList() } : {}),
          helpText: helpText || null,
          groupName: groupName || null,
          conditional,
          isRequired,
          trackChanges,
        }),
      'Property created. It is on the record editor now.',
    )
    if (ok) {
      setCreating(false)
      reset()
    }
  }

  const saveEdit = async () => {
    const field = editing
    if (!field) return
    const ok = await run(
      () =>
        api.admin.fields.update.mutate({
          id: field.id,
          label,
          ...(NEEDS_OPTIONS.has(field.type) ? { options: optionList() } : {}),
          helpText: helpText || null,
          groupName: groupName || null,
          conditional,
          isRequired,
          trackChanges,
        }),
      'Property saved.',
    )
    if (ok) setEditing(null)
  }

  const openEdit = (field: AdminField) => {
    setEditing(field)
    setLabel(field.label)
    setOptions(field.options.join('\n'))
    setHelpText(field.helpText ?? '')
    setGroupName(field.groupName ?? '')
    setIsRequired(field.isRequired)
    setTrackChanges(field.trackChanges)
    setConditional(field.conditional)
  }

  const openRemove = async (field: AdminField) => {
    setRemoving(field)
    setUsage(null)
    try {
      setUsage(await api.admin.fields.usage.query({ id: field.id }))
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
   *  Without it the list beside the table keeps the old name until the refresh
   *  lands, with the group just renamed selected and not in it. */
  const groupOf = (field: AdminField): string | null =>
    field.groupName && renamed?.from === field.groupName ? renamed.to : field.groupName

  const groups = [...new Set(rows.map(groupOf).filter((name): name is string => Boolean(name)))].sort()
  const countIn = (name: string) =>
    rows.filter((field) => (name === 'ungrouped' ? !groupOf(field) : groupOf(field) === name)).length
  const ungrouped = rows.filter((field) => !groupOf(field)).length

  const openUses = async (field: AdminField) => {
    if (openUse === field.id) {
      setOpenUse(null)
      return
    }
    setOpenUse(field.id)
    if (uses[field.id]) return
    try {
      const found = await api.admin.fields.usage.query({ id: field.id })
      setUses((current) => ({ ...current, [field.id]: found.usedIn }))
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const needle = query.trim().toLowerCase()
  const visible = rows.filter(
    (field) =>
      (group === '' || (group === 'ungrouped' ? !groupOf(field) : groupOf(field) === group)) &&
      (needle === '' ||
        field.label.toLowerCase().includes(needle) ||
        field.key.includes(needle) ||
        (field.helpText ?? '').toLowerCase().includes(needle)),
  )
  /** Reordering writes the whole ordered id list, so it can only be offered when
   *  the whole list is on screen. Hidden rather than broken, and said out loud. */
  const filtered = visible.length !== rows.length
  const { page, pager, offset } = usePagedRows(visible, 'properties')

  return (
    <div className="flex flex-col gap-4 md:flex-row md:items-start">
      {/* The group sidebar. Three hundred and seventy-two properties is a list
          nobody scrolls; the group is what makes it navigable, so it is a
          standing column rather than a dropdown to remember. It stacks above the
          list on a narrow screen instead of squeezing both. */}
      <nav
        aria-label="Property groups"
        className="flex shrink-0 flex-col gap-1 md:sticky md:top-4 md:w-56 md:max-h-[70vh] md:overflow-y-auto"
      >
        <GroupLink label="All properties" count={rows.length} active={group === ''} onPick={() => setGroup('')} />
        {groups.map((name) => (
          <div key={name} className="flex items-center gap-0.5">
            <GroupLink label={name} count={countIn(name)} active={group === name} onPick={() => setGroup(name)} />
            {canWrite ? (
              <IconButton
                label={`Rename ${name}`}
                icon={<ACTION_ICONS.edit size={14} />}
                onClick={() => {
                  setGrouping({ name, rename: true })
                  setGroupDraft(name)
                }}
              />
            ) : null}
          </div>
        ))}
        {ungrouped > 0 ? (
          <GroupLink
            label="Ungrouped"
            count={ungrouped}
            active={group === 'ungrouped'}
            onPick={() => setGroup('ungrouped')}
          />
        ) : null}
        {canWrite ? (
          <Button
            variant="tertiary"
            className="mt-1 w-full"
            onClick={() => {
              setGrouping({ name: '', rename: false })
              setGroupDraft('')
            }}
          >
            Create group
          </Button>
        ) : null}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {!canWrite ? (
          <p className="text-secondary">You need {hub} access to change the fields.</p>
        ) : (
        <Button variant="primary" onClick={() => { reset(); setCreating(true) }}>
          Create property
        </Button>
        )}

          <datalist id="property-groups">
          {groups.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      <div className="flex flex-wrap items-end gap-2">
          <Field id="property-search" label="Find">
            <TextInput
              id="property-search"
              value={query}
              placeholder="Name, key or description"
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
        </div>
      </div>

      {/* A group is made by putting properties in it, which is also how one is
          renamed away: there is nowhere else the name is kept. */}
      {canWrite && picked.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-hs border border-line bg-fill px-3 py-2">
          <span className="min-w-0 flex-1 tabular-nums">
            {picked.size.toLocaleString()} selected
          </span>
          <Select
            aria-label="Move the selected properties to a group"
            value=""
            onChange={(event) => {
              const name = event.target.value
              if (!name) return
              void run(
                () =>
                  api.admin.fields.moveToGroup.mutate({
                    object,
                    fieldIds: [...picked],
                    groupName: name === 'ungrouped' ? null : name,
                  }),
                'Moved.',
              ).then((ok) => ok && setPicked(new Set()))
            }}
            className="w-auto min-w-40"
          >
            <option value="">Move to group…</option>
            {groups.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value="ungrouped">Ungrouped</option>
          </Select>
          <Button variant="tertiary" onClick={() => setPicked(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}

      <p className="text-secondary tabular-nums">
        {filtered
          ? `${visible.length.toLocaleString()} of ${rows.length.toLocaleString()} properties`
          : `${rows.length.toLocaleString()} propert${rows.length === 1 ? 'y' : 'ies'}`}
        {filtered ? '. Clear the filter to reorder.' : ''}
      </p>

      <ul className="flex flex-col rounded-panel border border-line bg-surface">
        {page.map((field, index) => (
          <li
            key={field.id}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-divider px-3 py-2 last:border-0"
          >
            {canWrite ? (
              <input
                type="checkbox"
                aria-label={`Select ${field.label}`}
                checked={picked.has(field.id)}
                onChange={() => toggle(field.id)}
                className="mt-1 shrink-0"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{field.label}</span>
                <code className="text-small text-secondary">{field.key}</code>
                <span className="text-small text-secondary">{field.type}</span>
                {field.isRequired ? <Badge tone="warn">Required</Badge> : null}
                {field.isSystem ? <Badge tone="muted">Rawr keeps this</Badge> : null}
                {!field.isCustom && !field.isSystem ? <Badge tone="muted">Core</Badge> : null}
                {field.isHot ? <Badge tone="ok">Indexed{field.indexState ? ` · ${field.indexState}` : ''}</Badge> : null}
                {field.trackChanges ? <Badge tone="muted">On the timeline</Badge> : null}
                {groupOf(field) ? <Badge tone="muted">{groupOf(field)}</Badge> : null}
                {field.source ? <Badge tone="muted">from {field.source}</Badge> : null}
                {field.conditional ? <Badge tone="muted">Conditional</Badge> : null}
              </p>

              {/* The fill rate. A property nothing holds a value for is the one
                  worth deleting, and a percentage is the only form of that
                  number that survives an account growing. */}
              <p className="text-small text-secondary tabular-nums">
                {field.filledCount === null
                  ? 'Fill rate not measured yet'
                  : recordCount === 0
                    ? 'No records yet'
                    : `${Math.round((field.filledCount / recordCount) * 100)}% filled · ${field.filledCount.toLocaleString()} of ${recordCount.toLocaleString()}`}
                {field.filledAt ? ` · as of ${new Date(field.filledAt).toLocaleDateString()}` : ''}
              </p>

              {openUse === field.id ? (
                <p className="text-small text-secondary">
                  {uses[field.id] === undefined
                    ? 'Looking…'
                    : uses[field.id]!.length === 0
                      ? 'Nothing uses this property.'
                      : `Used in: ${uses[field.id]!.map((use) => `${use.name} (${use.kind})`).join(', ')}`}
                </p>
              ) : null}
              {field.helpText ? <p className="text-small text-secondary">{field.helpText}</p> : null}
              {field.options.length > 0 ? (
                <p className="text-small text-secondary">
                  {field.options.length} choice{field.options.length === 1 ? '' : 's'}:{' '}
                  {field.options.slice(0, 6).join(', ')}
                  {field.options.length > 6 ? ` and ${field.options.length - 6} more` : ''}
                </p>
              ) : null}
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              {!canWrite ? null : (
                <>
              {filtered ? null : (
                <>
                  <IconButton
                    label={`Move ${field.label} up`}
                    icon={<ACTION_ICONS.moveUp size={16} />}
                    disabled={busy || offset + index === 0}
                    onClick={() => move(offset + index, -1)}
                  />
                  <IconButton
                    label={`Move ${field.label} down`}
                    icon={<ACTION_ICONS.moveDown size={16} />}
                    disabled={busy || offset + index === rows.length - 1}
                    onClick={() => move(offset + index, 1)}
                  />
                </>
              )}
              {field.isSystem ? null : (
                <IconButton
                  label={`Edit ${field.label}`}
                  icon={<ACTION_ICONS.edit size={16} />}
                  onClick={() => openEdit(field)}
                />
              )}
              <Button
                variant="tertiary"
                aria-expanded={openUse === field.id}
                onClick={() => void openUses(field)}
              >
                Used in
              </Button>
              {/* Keeps its words: "index it" is a decision about cost and speed,
                  not a routine row action, and no glyph says it. */}
              {field.isCustom && field.storage === 'jsonb' && !field.isHot ? (
                <Button
                  variant="tertiary"
                  busy={busy}
                  onClick={() =>
                    void run(
                      () => api.admin.fields.promoteToHot.mutate({ fieldId: field.id }),
                      'Index requested. The worker builds it within the minute.',
                    )
                  }
                >
                  Index it
                </Button>
              ) : null}
              {field.isCustom && field.storage === 'jsonb' ? (
                <IconButton
                  label={`Delete ${field.label}`}
                  tone="destructive"
                  icon={<ACTION_ICONS.delete size={16} />}
                  onClick={() => void openRemove(field)}
                />
              ) : null}
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      {pager}

      {deleted.length > 0 ? (
        <section className="flex flex-col gap-2">
          <div>
            <h3 className="text-base font-semibold">Deleted properties</h3>
            <p className="text-secondary">
              Hidden everywhere, data untouched. Restore puts one back exactly as it was. Purging
              strips the value out of every record and cannot be undone.
            </p>
          </div>
          <ul className="flex flex-col rounded-panel border border-line bg-surface">
            {deleted.map((field) => (
              <li
                key={field.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-divider px-3 py-2 last:border-0"
              >
                <span className="min-w-0">
                  <span className="font-medium">{field.label}</span>{' '}
                  <code className="text-small text-secondary">{field.key}</code>
                </span>
                <span className="flex shrink-0 items-center gap-0.5">
                  {canWrite ? (
                  <IconButton
                    label={`Restore ${field.label}`}
                    icon={<ACTION_ICONS.restore size={16} />}
                    disabled={busy}
                    onClick={() =>
                      void run(() => api.admin.fields.restore.mutate({ id: field.id }), 'Restored.')
                    }
                  />
                  ) : null}
                  {canWrite ? (
                    <IconButton
                      label={`Purge ${field.label} from every record`}
                      tone="destructive"
                      icon={<ACTION_ICONS.delete size={16} />}
                      onClick={() => setPurging(field)}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---------------------------------------------------------- create */}
      <Modal open={creating} title={`Create property on ${object}`} onClose={() => setCreating(false)}>
        <div className="flex flex-col gap-3">
          <Field id="prop-label" label="Label" hint="What people see on the record.">
            <TextInput
              id="prop-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              autoFocus
            />
          </Field>

          <Field
            id="prop-key"
            label="Key"
            hint="Stored under this name, in imports and in the agent tools. Generated from the label, and it never changes afterwards."
          >
            <TextInput
              id="prop-key"
              value={keyTouched ? key : keyFrom(label)}
              onChange={(event) => {
                setKeyTouched(true)
                setKey(event.target.value)
              }}
            />
          </Field>

          <Field id="prop-type" label="Type">
            <Select
              id="prop-type"
              value={type}
              onChange={(event) => setType(event.target.value as FieldType)}
            >
              {TYPE_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.types.map((candidate) => (
                    <option key={candidate} value={candidate}>
                      {candidate}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>

          {NEEDS_OPTIONS.has(type) ? (
            <Field id="prop-options" label="Choices" hint="One per line.">
              <TextArea id="prop-options" value={options} onChange={(event) => setOptions(event.target.value)} />
            </Field>
          ) : null}

          <Field id="prop-help" label="Help text" hint="Optional. Shown under the input.">
            <TextInput id="prop-help" value={helpText} onChange={(event) => setHelpText(event.target.value)} />
          </Field>

          {/* A free text box with the groups already in use offered beside it: a
              group is created by naming one, the way HubSpot's is, and the
              filter above only ever showed groups nothing could write. */}
          <Field id="prop-group" label="Group" hint="Optional. Properties with the same group are shown together.">
            <TextInput
              id="prop-group"
              list="property-groups"
              value={groupName}
              placeholder="Contact information"
              onChange={(event) => setGroupName(event.target.value)}
            />
          </Field>


          <ConditionalEditor
            ownKey={editing?.key ?? (keyTouched ? key : keyFrom(label))}
            fields={filterFields}
            value={conditional}
            onChange={setConditional}
          />

          <Toggles
            isRequired={isRequired}
            trackChanges={trackChanges}
            onRequired={setIsRequired}
            onTrack={setTrackChanges}
          />

          <div className="flex flex-wrap gap-2">
            <Button variant="tertiary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy} disabled={!label.trim()} onClick={() => void create()}>
              Create property
            </Button>
          </div>
        </div>
      </Modal>

      {/* ------------------------------------------------------------ edit */}
      <Modal open={editing !== null} title={`Edit ${editing?.label ?? ''}`} onClose={() => setEditing(null)}>
        <div className="flex flex-col gap-3">
          <p className="text-secondary">
            The key <code>{editing?.key}</code> and the type <code>{editing?.type}</code> are fixed.
            Changing either would change what the stored values mean.
          </p>

          <Field id="edit-label" label="Label">
            <TextInput id="edit-label" value={label} onChange={(event) => setLabel(event.target.value)} autoFocus />
          </Field>

          {editing && NEEDS_OPTIONS.has(editing.type) ? (
            <Field
              id="edit-options"
              label="Choices"
              hint="One per line. Removing a choice does not clear it from records that already hold it."
            >
              <TextArea id="edit-options" value={options} onChange={(event) => setOptions(event.target.value)} />
            </Field>
          ) : null}

          <Field id="edit-help" label="Help text">
            <TextInput id="edit-help" value={helpText} onChange={(event) => setHelpText(event.target.value)} />
          </Field>

          <Field id="edit-group" label="Group" hint="Optional. Properties with the same group are shown together.">
            <TextInput
              id="edit-group"
              list="property-groups"
              value={groupName}
              placeholder="Contact information"
              onChange={(event) => setGroupName(event.target.value)}
            />
          </Field>


          <ConditionalEditor
            ownKey={editing?.key ?? (keyTouched ? key : keyFrom(label))}
            fields={filterFields}
            value={conditional}
            onChange={setConditional}
          />

          <Toggles
            isRequired={isRequired}
            trackChanges={trackChanges}
            onRequired={setIsRequired}
            onTrack={setTrackChanges}
          />

          <div className="flex flex-wrap gap-2">
            <Button variant="tertiary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy} disabled={!label.trim()} onClick={() => void saveEdit()}>
              Save
            </Button>
          </div>
        </div>
      </Modal>

      {/* ---------------------------------------------------------- delete */}
      <Modal open={removing !== null} size="sm" title={`Delete ${removing?.label ?? ''}`} onClose={() => setRemoving(null)}>
        <div className="flex flex-col gap-3">
          <p>
            The property disappears from every screen immediately.{' '}
            {usage === null
              ? 'Counting how many records hold a value…'
              : usage.filled === 0
                ? 'No record holds a value for it.'
                : `${usage.filled.toLocaleString()} record${usage.filled === 1 ? '' : 's'} hold a value, and every one of those values stays exactly where it is.`}
          </p>
          <p className="text-secondary">
            Nothing is lost here. Restoring puts it back. Purging, which is a separate action, is
            what actually removes the data.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="tertiary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              busy={busy}
              onClick={() => {
                const field = removing
                if (!field) return
                void run(() => api.admin.fields.remove.mutate({ id: field.id }), 'Deleted. The data is still there.').then(
                  (ok) => ok && setRemoving(null),
                )
              }}
            >
              Delete property
            </Button>
          </div>
        </div>
      </Modal>

      {/* ----------------------------------------------------------- purge */}
      <Modal open={purging !== null} size="sm" title={`Purge ${purging?.label ?? ''}`} onClose={() => setPurging(null)}>
        <div className="flex flex-col gap-3">
          <Alert>
            This strips <code>{purging?.key}</code> out of every record in the account and removes
            the definition. It cannot be undone and there is no copy anywhere else.
          </Alert>
          <div className="flex flex-wrap gap-2">
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
                  toast('info', `${result.stripped.toLocaleString()} records had the value stripped.`)
                }, 'Purged.').then((ok) => ok && setPurging(null))
              }}
            >
              Purge permanently
            </Button>
          </div>
        </div>
      </Modal>

      {/* ----------------------------------------------------------- group */}
      <Modal
        open={grouping !== null}
        size="sm"
        title={grouping?.rename ? `Rename ${grouping.name}` : 'Create group'}
        onClose={() => setGrouping(null)}
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
          {grouping?.rename ? null : (
            <p className="text-secondary">
              A group is the name on the properties in it, so this one exists once something is
              under it. Select properties in the list and move them here.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="tertiary" onClick={() => setGrouping(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={!groupDraft.trim()}
              onClick={() => {
                const target = grouping
                if (!target) return
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
                  setGroup(name)
                })
              }}
            >
              {grouping?.rename ? 'Rename group' : 'Create group'}
            </Button>
          </div>
          {grouping && !grouping.rename && picked.size === 0 ? (
            <p className="text-secondary">
              Nothing is selected, so the group would have no properties in it and nowhere to be
              stored. Tick the ones that belong in it first.
            </p>
          ) : null}
        </div>
      </Modal>
      </div>
    </div>
  )
}

const GroupLink = ({
  label,
  count,
  active,
  onPick,
}: {
  label: string
  count: number
  active: boolean
  onPick: () => void
}) => (
  <button
    type="button"
    aria-current={active ? 'true' : undefined}
    onClick={onPick}
    className={cn(
      'flex min-w-0 flex-1 items-baseline justify-between gap-2 rounded-hs px-2 py-1 text-left',
      active ? 'bg-fill font-medium' : 'hover:bg-fill',
    )}
  >
    <span className="min-w-0 break-words">{label}</span>
    <span className="shrink-0 text-small text-secondary tabular-nums">{count.toLocaleString()}</span>
  </button>
)

/** Conditional property logic, written with the filter builder rather than a
 *  second control that means the same thing. HubSpot puts the rule on the
 *  controlling property and lists its dependants; this puts it on the property
 *  that is hidden, which is the one place anything has to look to decide whether
 *  to draw it. */
const ConditionalEditor = ({
  ownKey,
  fields,
  value,
  onChange,
}: {
  ownKey: string
  fields: FilterField[]
  value: Conditional | null
  onChange: (next: Conditional | null) => void
}) => {
  const [open, setOpen] = useState(value !== null)
  const others = fields.filter((field) => field.key !== ownKey)

  if (others.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={open}
          onChange={(event) => {
            setOpen(event.target.checked)
            if (!event.target.checked) onChange(null)
          }}
        />
        <span>
          Only show this when other properties say so
          <span className="block text-small text-secondary">
            While the rule does not match, the property is off the record. An import, a job and the
            agent tools still write it, exactly as HubSpot's conditional logic does.
          </span>
        </span>
      </label>
      {open ? (
        <FilterBuilder
          fields={others}
          value={value ? [{ conjunction: value.conjunction, conditions: value.conditions as Group['conditions'] }] : []}
          onApply={(groups) => {
            const [first] = groups
            onChange(first ? { conjunction: first.conjunction, conditions: first.conditions } : null)
          }}
        />
      ) : null}
    </div>
  )
}

const Toggles = ({
  isRequired,
  trackChanges,
  onRequired,
  onTrack,
}: {
  isRequired: boolean
  trackChanges: boolean
  onRequired: (next: boolean) => void
  onTrack: (next: boolean) => void
}) => (
  <div className="flex flex-col gap-1">
    <label className="flex items-start gap-2">
      <input type="checkbox" checked={isRequired} onChange={(event) => onRequired(event.target.checked)} />
      <span>
        Required
        <span className="block text-small text-secondary">
          A record cannot be created without it. Existing records that lack it are untouched.
        </span>
      </span>
    </label>
    <label className="flex items-start gap-2">
      <input type="checkbox" checked={trackChanges} onChange={(event) => onTrack(event.target.checked)} />
      <span>
        Put changes on the timeline
        <span className="block text-small text-secondary">
          Off by default. An import of 88,000 contacts would otherwise write a timeline entry per
          field per row.
        </span>
      </span>
    </label>
  </div>
)

const Badge = ({ tone, children }: { tone: 'ok' | 'warn' | 'muted'; children: React.ReactNode }) => (
  <span
    className={cn(
      'rounded-hs px-1.5 py-0.5 text-small',
      tone === 'ok' && 'bg-success-subtle text-success',
      tone === 'warn' && 'bg-warning-subtle text-warning',
      tone === 'muted' && 'bg-fill text-secondary',
    )}
  >
    {children}
  </span>
)
