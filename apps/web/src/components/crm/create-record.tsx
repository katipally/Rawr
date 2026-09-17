'use client'

import { matchesConditional } from '@rawr/db/registry'
import { Button, Field, Modal, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useNavigation } from '~/components/navigation.tsx'
import { useId, useState } from 'react'
import { useDraft } from '~/lib/drafts.ts'
import { objectView, recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { FieldInput, firstStageOf, scoped, type EditableField } from './field-input.tsx'
import { RecordPicker, type PickedRecord } from './record-picker.tsx'

export type CreateField = EditableField

export type CreateRecordDialogProps = {
  account: string
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
  account,
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
  // A deal starts on the first pipeline's first stage, the way HubSpot opens the
  // form, rather than on "Not set" twice.
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const pipelineId = initial.pipeline_id ?? fields.find((field) => field.key === 'pipeline_id')?.choices?.[0]?.id
    return pipelineId ? { ...initial, pipeline_id: pipelineId, stage_id: initial.stage_id ?? firstStageOf(fields, pipelineId) } : initial
  })
  // HubSpot's create-deal form asks for a contact and a company. The company is
  // a field on the deal; the contact is an association, made once the deal exists.
  const [contact, setContact] = useState<PickedRecord | null>(null)
  /** The page under this dialog refreshes on its own -- the enrichment banner's
   *  count changes behind it -- and a refresh that remounts the toolbar takes this
   *  component's state with it, emptying a half-filled form under somebody's hands.
   *  The draft outlives the mount (and the tab), so it comes back. */
  const { forget } = useDraft(account, object, undefined, values, (draft) =>
    setValues((current) => ({ ...current, ...draft })),
  )

  const [error, setError] = useState<string | null>(null)
  const [duplicateId, setDuplicateId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Cancel and the modal's own X are a dismissal, not a discard: the draft is
  // only forgotten once the record actually exists.
  const close = () => {
    onClose()
  }

  /** Conditional property logic, the same rule the record panel applies: a
   *  property whose rule does not match what has been filled in so far is not
   *  asked for, and a required one that is not asked for cannot hold the form up. */
  const asked = fields.filter((field) => matchesConditional(field.conditional, values))

  const submit = async () => {
    const filled = Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== '' && value !== null && value !== undefined),
    )
    // Nothing at all is a mis-click, not a record. Without this the dialog writes
    // a row with every column null, which reads as "Unnamed company" in the list
    // and can only be found by whoever notices it.
    const missing = asked.filter((field) => field.isRequired && filled[field.key] === undefined)
    if (missing.length > 0 || Object.keys(filled).length === 0) {
      setError(
        missing.length > 0
          ? `${missing.map((field) => field.label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} needed.`
          : `Fill in something before creating a ${objectLabel.toLowerCase()}.`,
      )
      return
    }
    setSaving(true)
    setError(null)
    setDuplicateId(null)
    try {
      const created = await api.crm.records.create.mutate({ object, values: filled })
      if (contact) {
        await api.crm.associations.add.mutate({
          a: { entityType: object, entityId: created.id },
          b: { entityType: 'contact', entityId: contact.id },
          label: null,
        })
      }
      for (const warning of created.warnings) toast('info', warning)
      if (created.autoCompanyId) {
        toast('info', 'Filed under the company that matches the email domain.')
      }
      toast('success', `${objectLabel} created.`)
      forget()
      close()
      if (onCreated) await onCreated(created.id)
      else navigate(recordPath(account, object, created.id))
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
    <Modal open title={`Create ${objectLabel.toLowerCase()}`} onClose={close}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {asked.map((field, index) => (
          <Field
            key={field.key}
            id={`${prefix}-${field.key}`}
            label={field.label}
            required={field.isRequired}
            {...(field.helpText ? { hint: field.helpText } : {})}
          >
            <FieldInput
              id={`${prefix}-${field.key}`}
              field={scoped(field, values)}
              value={values[field.key]}
              autoFocus={index === 0}
              onChange={(value) =>
                setValues((current) =>
                  field.key === 'pipeline_id'
                    ? { ...current, pipeline_id: value, stage_id: firstStageOf(fields, value) }
                    : { ...current, [field.key]: value },
                )
              }
            />
          </Field>
        ))}

        {object === 'deal' && !initial.company_id ? (
          <Field id={`${prefix}-contact`} label="Associated contact">
            <RecordPicker
              id={`${prefix}-contact`}
              object="contact"
              label="Associated contact"
              value={contact}
              onChange={setContact}
            />
          </Field>
        ) : null}

        {error ? (
          <p role="alert" className="text-error">
            {error}
            {duplicateId ? (
              <>
                {' '}
                <Link href={objectView(account, object, 'all')}>
                  Find it in the list
                </Link>{' '}
                and merge instead.
              </>
            ) : null}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="tertiary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={saving}>
            Create {objectLabel.toLowerCase()}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
