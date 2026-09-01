'use client'

import { Button, Field, Modal, Select, TextArea, TextInput, cn, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { AdminField, FieldType, ObjectKey } from '@rawr/db'
import { api, errorMessage } from '~/lib/rpc.ts'

export type PropertyListProps = {
  object: ObjectKey
  rows: AdminField[]
  deleted: AdminField[]
  role: string
}

/** Field types that need a list of choices, and the types a person actually reaches
 *  for. The registry knows all nineteen; offering them in the order somebody thinks
 *  about them is a UI decision, so it lives here. */
const TYPE_GROUPS: { label: string; types: FieldType[] }[] = [
  { label: 'Text', types: ['text', 'long_text', 'email', 'phone', 'url', 'linkedin', 'address'] },
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

export const PropertyList = ({ object, rows, deleted, role }: PropertyListProps) => {
  const router = useRouter()
  const toast = useToast()

  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<AdminField | null>(null)
  const [removing, setRemoving] = useState<AdminField | null>(null)
  const [usage, setUsage] = useState<{ filled: number } | null>(null)
  const [purging, setPurging] = useState<AdminField | null>(null)
  const [busy, setBusy] = useState(false)

  const [label, setLabel] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [type, setType] = useState<FieldType>('text')
  const [options, setOptions] = useState('')
  const [helpText, setHelpText] = useState('')
  const [isRequired, setIsRequired] = useState(false)
  const [trackChanges, setTrackChanges] = useState(false)

  const reset = () => {
    setLabel('')
    setKey('')
    setKeyTouched(false)
    setType('text')
    setOptions('')
    setHelpText('')
    setIsRequired(false)
    setTrackChanges(false)
  }

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
    setIsRequired(field.isRequired)
    setTrackChanges(field.trackChanges)
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

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="primary" onClick={() => { reset(); setCreating(true) }}>
          Create property
        </Button>
      </div>

      <ul className="flex flex-col rounded-panel border border-line bg-surface">
        {rows.map((field, index) => (
          <li
            key={field.id}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-divider px-3 py-2 last:border-0"
          >
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
              </p>
              {field.helpText ? <p className="text-small text-secondary">{field.helpText}</p> : null}
              {field.options.length > 0 ? (
                <p className="text-small text-secondary">
                  {field.options.length} choice{field.options.length === 1 ? '' : 's'}:{' '}
                  {field.options.slice(0, 6).join(', ')}
                  {field.options.length > 6 ? ` and ${field.options.length - 6} more` : ''}
                </p>
              ) : null}
            </div>

            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="tertiary" busy={busy} onClick={() => move(index, -1)} disabled={index === 0}>
                Up
              </Button>
              <Button
                variant="tertiary"
                busy={busy}
                onClick={() => move(index, 1)}
                disabled={index === rows.length - 1}
              >
                Down
              </Button>
              {field.isSystem ? null : (
                <Button variant="tertiary" onClick={() => openEdit(field)}>
                  Edit
                </Button>
              )}
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
                <Button variant="destructive" onClick={() => void openRemove(field)}>
                  Delete
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {deleted.length > 0 ? (
        <section className="flex flex-col gap-2">
          <div>
            <h3 className="font-medium">Deleted properties</h3>
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
                <span className="flex shrink-0 gap-2">
                  <Button
                    variant="tertiary"
                    busy={busy}
                    onClick={() =>
                      void run(() => api.admin.fields.restore.mutate({ id: field.id }), 'Restored.')
                    }
                  >
                    Restore
                  </Button>
                  {role === 'admin' ? (
                    <Button variant="destructive" onClick={() => setPurging(field)}>
                      Purge
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---------------------------------------------------------- create */}
      <Modal open={creating} title={`New property on ${object}`} onClose={() => setCreating(false)}>
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

          <Toggles
            isRequired={isRequired}
            trackChanges={trackChanges}
            onRequired={setIsRequired}
            onTrack={setTrackChanges}
          />

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={busy} disabled={!label.trim()} onClick={() => void create()}>
              Create property
            </Button>
            <Button variant="tertiary" onClick={() => setCreating(false)}>
              Cancel
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

          <Toggles
            isRequired={isRequired}
            trackChanges={trackChanges}
            onRequired={setIsRequired}
            onTrack={setTrackChanges}
          />

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" busy={busy} disabled={!label.trim()} onClick={() => void saveEdit()}>
              Save
            </Button>
            <Button variant="tertiary" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* ---------------------------------------------------------- delete */}
      <Modal open={removing !== null} title={`Delete ${removing?.label ?? ''}`} onClose={() => setRemoving(null)}>
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
            <Button variant="tertiary" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* ----------------------------------------------------------- purge */}
      <Modal open={purging !== null} title={`Purge ${purging?.label ?? ''}`} onClose={() => setPurging(null)}>
        <div className="flex flex-col gap-3">
          <p className="rounded-hs border border-error bg-error-subtle px-3 py-2 text-error">
            This strips <code>{purging?.key}</code> out of every record in the workspace and removes
            the definition. It cannot be undone and there is no copy anywhere else.
          </p>
          <div className="flex flex-wrap gap-2">
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
            <Button variant="tertiary" onClick={() => setPurging(null)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
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
