'use client'

import { Button, Field, Modal, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useNavigation } from '~/components/navigation.tsx'
import { useId, useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { FieldInput, type EditableField } from './field-input.tsx'

export type CreateField = EditableField

export type CreateRecordDialogProps = {
  workspace: string
  object: string
  objectLabel: string
  fields: CreateField[]
  onClose: () => void
  /** Prefills a relation, used when creating from a record's association rail. */
  initial?: Record<string, unknown>
  /** Where to go once it exists. Absent means open the new record; the rail passes
   *  one so the person stays where they were and sees the link appear. */
  onCreated?: (id: string) => Promise<void> | void
}

export const CreateRecordDialog = ({
  workspace,
  object,
  objectLabel,
  fields,
  onClose,
  initial = {},
  onCreated,
}: CreateRecordDialogProps) => {
  const { navigate } = useNavigation()
  const toast = useToast()
  const prefix = useId()
  const [values, setValues] = useState<Record<string, unknown>>(initial)
  const [error, setError] = useState<string | null>(null)
  const [duplicateId, setDuplicateId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    setError(null)
    setDuplicateId(null)
    try {
      const filled = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value !== '' && value !== null && value !== undefined),
      )
      const created = await api.crm.records.create.mutate({ object, values: filled })
      for (const warning of created.warnings) toast('info', warning)
      if (created.autoCompanyId) {
        toast('info', 'Filed under the company that matches the email domain.')
      }
      toast('success', `${objectLabel} created.`)
      onClose()
      if (onCreated) await onCreated(created.id)
      else navigate(recordPath(workspace, object, created.id))
    } catch (cause) {
      const message = errorMessage(cause)
      setError(message)
      // A duplicate is not a dead end: the other record is offered as a link.
      const match = /already belongs to another record/.test(message)
      if (match) setDuplicateId('unknown')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open title={`Create ${objectLabel.toLowerCase()}`} onClose={onClose}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {fields.map((field, index) => (
          <Field
            key={field.key}
            id={`${prefix}-${field.key}`}
            label={field.label}
            required={field.isRequired}
            {...(field.helpText ? { hint: field.helpText } : {})}
          >
            <FieldInput
              id={`${prefix}-${field.key}`}
              field={field}
              value={values[field.key]}
              autoFocus={index === 0}
              onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))}
            />
          </Field>
        ))}

        {error ? (
          <p role="alert" className="text-error">
            {error}
            {duplicateId ? (
              <>
                {' '}
                <Link href={`/contacts/${workspace}/objects/${object}/views/all/list`}>
                  Find it in the list
                </Link>{' '}
                and merge instead.
              </>
            ) : null}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" busy={saving}>
            Create {objectLabel.toLowerCase()}
          </Button>
          <Button type="button" variant="tertiary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  )
}
