'use client'

import { Button, Select, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { api, errorMessage } from '~/lib/rpc.ts'
import { EnrollDialog } from './enroll-dialog.tsx'
import { FieldInput, type EditableField } from './field-input.tsx'

export type BulkBarProps = {
  object: ObjectKey
  objectLabel: string
  /** Ids ticked in the table. The bar only exists while this is non-empty. */
  ids: string[]
  fields: EditableField[]
  onDone: () => void
  onClear: () => void
}

/** One field, one value, applied to everything ticked. A5.
 *
 *  Deliberately one field at a time. A multi-field bulk editor reads as a record
 *  form and invites somebody to blank three properties across two hundred records
 *  by accident; one field with the count in the button says exactly what is about
 *  to happen. Rows that refuse the change come back named, because "12 of 50
 *  failed" is not something anybody can act on. */
export const BulkBar = ({ object, objectLabel, ids, fields, onDone, onClear }: BulkBarProps) => {
  const router = useRouter()
  const toast = useToast()
  const [fieldKey, setFieldKey] = useState('')
  const [value, setValue] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<{ id: string; displayName: string; reason: string }[]>([])
  const [showEnroll, setShowEnroll] = useState(false)

  const field = fields.find((candidate) => candidate.key === fieldKey)
  const noun = ids.length === 1 ? objectLabel.toLowerCase() : `${objectLabel.toLowerCase()}s`

  /** Puts a bulk edit back. Not a transaction and not pretending to be one: a
   *  record somebody else changed in between is reported by name rather than
   *  quietly overwritten, which is the same promise the edit itself makes. */
  const undo = async (key: string, previous: { id: string; values: Record<string, unknown> }[]) => {
    const byValue = new Map<string, { value: unknown; ids: string[] }>()
    for (const row of previous) {
      const value = row.values[key] ?? null
      const bucket = JSON.stringify(value)
      const found = byValue.get(bucket)
      if (found) found.ids.push(row.id)
      else byValue.set(bucket, { value, ids: [row.id] })
    }
    try {
      let restored = 0
      for (const { value, ids: group } of byValue.values()) {
        const result = await api.crm.records.bulkUpdate.mutate({
          object,
          ids: group,
          values: { [key]: value },
        })
        restored += result.updated
      }
      toast('success', `Put back on ${restored} ${restored === 1 ? objectLabel.toLowerCase() : `${objectLabel.toLowerCase()}s`}.`)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  const apply = async () => {
    if (!field) return
    setBusy(true)
    setFailed([])
    try {
      const result = await api.crm.records.bulkUpdate.mutate({
        object,
        ids,
        values: { [field.key]: value === '' ? null : value },
      })
      setFailed(result.failed)
      if (result.updated > 0) {
        const noun = result.updated === 1 ? objectLabel.toLowerCase() : `${objectLabel.toLowerCase()}s`
        toast('success', `${field.label} changed on ${result.updated} ${noun}.`, {
          label: 'Undo',
          // Grouped by the value each record held, so putting two hundred records
          // back costs one call per distinct old value rather than two hundred.
          // The toast stays until it is used or dismissed, because five seconds is
          // not long enough to notice what you just did to two hundred records.
          run: () => undo(field.key, result.previous),
        })
      }
      if (result.failed.length === 0) {
        setFieldKey('')
        setValue(null)
        onDone()
      }
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-panel border border-line-interactive bg-accent-subtle p-3">
      <div className="flex flex-wrap items-end gap-2">
        <p className="font-medium">
          {ids.length} {noun} selected
        </p>

        {/* A sequence sends to a person, so this is a contact-only action. */}
        {object === 'contact' ? (
          <Button variant="primary" onClick={() => setShowEnroll(true)}>
            Add to a sequence
          </Button>
        ) : null}

        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-small text-secondary">Change</span>
          <Select
            value={fieldKey}
            onChange={(event) => {
              setFieldKey(event.target.value)
              setValue(null)
              setFailed([])
            }}
          >
            <option value="">Pick a field</option>
            {fields.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.label}
              </option>
            ))}
          </Select>
        </label>

        {field ? (
          <label className="flex min-w-0 flex-col gap-1">
            <span className="text-small text-secondary">To</span>
            <FieldInput id="bulk-value" field={field} value={value} onChange={setValue} />
          </label>
        ) : null}

        <Button variant="primary" busy={busy} disabled={!field} onClick={() => void apply()}>
          Apply to {ids.length}
        </Button>
        <Button variant="tertiary" onClick={onClear}>
          Clear selection
        </Button>
      </div>

      {failed.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1">
          <p className="text-error">
            {failed.length} of {ids.length} could not be changed. Everything else was saved.
          </p>
          <ul className="flex flex-col gap-0.5">
            {failed.map((row) => (
              <li key={row.id} className="text-small text-secondary">
                <span className="font-medium">{row.displayName}</span> — {row.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {showEnroll ? (
        <EnrollDialog
          contactIds={ids}
          contactLabel={`${ids.length} ${noun}`}
          onClose={() => setShowEnroll(false)}
          onEnrolled={() => {
            onDone()
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}
