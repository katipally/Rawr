'use client'

import { Button, Select, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { api, errorMessage } from '~/lib/rpc.ts'
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

  const field = fields.find((candidate) => candidate.key === fieldKey)
  const noun = ids.length === 1 ? objectLabel.toLowerCase() : `${objectLabel.toLowerCase()}s`

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
        toast('success', `${field.label} changed on ${result.updated} ${result.updated === 1 ? objectLabel.toLowerCase() : `${objectLabel.toLowerCase()}s`}.`)
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

        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-small text-secondary">Change</span>
          <Select
            aria-label="Which field to change"
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
    </div>
  )
}
