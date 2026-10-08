'use client'

import { matchesConditional } from '@rawr/db/registry'
import { Button, Field, SidePanel, useToast } from '@rawr/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useNavigation } from '~/components/navigation.tsx'
import { useId, useState } from 'react'
import { useDraft } from '~/lib/drafts.ts'
import { objectView, recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { FieldInput, firstStageOf, scoped, type EditableField } from './field-input.tsx'
import { PropertySearch } from './property-search.tsx'
import { RecordPicker, type PickedRecord } from './record-picker.tsx'
import { useFormat } from '~/components/zone.tsx'

export type CreateField = EditableField

export type CreateRecordPanelProps = {
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

const isEmpty = (value: unknown): boolean =>
  value === '' || value === null || value === undefined || (Array.isArray(value) && value.length === 0)

const filledOf = (values: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => !isEmpty(value)))

export const CreateRecordPanel = ({
  account,
  object,
  objectLabel,
  fields,
  onClose,
  initial = {},
  onCreated,
}: CreateRecordPanelProps) => {
  const fmt = useFormat()
  const { navigate } = useNavigation()
  const router = useRouter()
  const toast = useToast()
  const prefix = useId()
  // A deal starts on the first pipeline's first stage, the way HubSpot opens the
  // form, rather than on "Not set" twice. It is also what "clear the fields"
  // returns to, and what counts as nothing typed.
  const [blank] = useState<Record<string, unknown>>(() => {
    const pipelineId = initial.pipeline_id ?? fields.find((field) => field.key === 'pipeline_id')?.choices?.[0]?.id
    return pipelineId ? { ...initial, pipeline_id: pipelineId, stage_id: initial.stage_id ?? firstStageOf(fields, pipelineId) } : initial
  })
  const [values, setValues] = useState(blank)
  // HubSpot's create-deal form asks for a contact and a company. The company is
  // a field on the deal; the contact is an association, made once the deal exists.
  const [contact, setContact] = useState<PickedRecord | null>(null)
  /** The page under this panel refreshes on its own -- the enrichment banner's
   *  count changes behind it -- and a refresh that remounts the toolbar takes this
   *  component's state with it, emptying a half-filled form under somebody's hands.
   *  The draft outlives the mount (and the tab), so it comes back. */
  const { forget } = useDraft(account, object, undefined, values, (draft) =>
    setValues((current) => ({ ...current, ...draft })),
  )

  const [error, setError] = useState<string | null>(null)
  const [duplicateId, setDuplicateId] = useState<string | null>(null)
  const [saving, setSaving] = useState<'create' | 'another' | null>(null)
  const [showMore, setShowMore] = useState(false)
  const [needle, setNeedle] = useState('')

  // Cancel and the panel's own X are a dismissal, not a discard: the draft is
  // only forgotten once the record actually exists.
  const close = () => {
    onClose()
  }

  /** Conditional property logic, the same rule the record panel applies: a
   *  property whose rule does not match what has been filled in so far is not
   *  asked for, and a required one that is not asked for cannot hold the form up. */
  const asked = fields.filter((field) => matchesConditional(field.conditional, values))
  const identity = asked.filter((field) => field.identity !== undefined)
  // What names a record, then whatever the account insists on. Every other
  // property sits behind "More properties", so the form opens on a few fields
  // rather than on every property the object has.
  const lead = asked
    .filter((field) => field.identity !== undefined || field.isRequired)
    .sort((a, b) => (a.identity ?? asked.length) - (b.identity ?? asked.length))
  const rest = asked.filter((field) => !lead.includes(field))
  const query = needle.trim().toLowerCase()
  const matching = query ? rest.filter((field) => field.label.toLowerCase().includes(query)) : rest

  const filled = filledOf(values)
  const restFilled = rest.filter((field) => field.key in filled).length
  const missing = asked.filter((field) => field.isRequired && !(field.key in filled))
  // Nothing at all is a mis-click, not a record. Without a name, an email or a
  // domain the list reads "Unnamed company" and only whoever notices can find it.
  const needs =
    missing.length > 0
      ? `${missing.map((field) => field.label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} needed.`
      : identity.length > 0 && !identity.some((field) => field.key in filled)
        ? `Fill in ${identity.length === 1 ? identity[0]!.label : `at least one of ${identity.map((field) => field.label).join(', ')}`}.`
        : null
  const dirty = contact !== null || Object.keys({ ...filled, ...blank }).some((key) => filled[key] !== blank[key])

  const submit = async (another: boolean) => {
    if (needs) return
    setSaving(another ? 'another' : 'create')
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
      forget()
      if (another) {
        toast('success', `${created.displayName} created.`, {
          label: 'View',
          run: () => navigate(recordPath(account, object, created.id)),
        })
        setValues(blank)
        setContact(null)
        setNeedle('')
        document.getElementById(`${prefix}-${lead[0]?.key}`)?.focus()
        // The list behind the panel is where the new record has to show up.
        if (onCreated) await onCreated(created.id)
        else router.refresh()
        return
      }
      toast('success', `${objectLabel} created.`)
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
      setSaving(null)
    }
  }

  const renderField = (field: CreateField, autoFocus = false) => (
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
        autoFocus={autoFocus}
        onChange={(value) =>
          setValues((current) =>
            field.key === 'pipeline_id'
              ? { ...current, pipeline_id: value, stage_id: firstStageOf(fields, value) }
              : { ...current, [field.key]: value },
          )
        }
      />
    </Field>
  )

  return (
    <SidePanel
      open
      title={`Create ${objectLabel.toLowerCase()}`}
      onClose={close}
      onSubmit={() => void submit(false)}
      dirty={dirty}
      footer={
        <>
          <Button type="submit" variant="primary" busy={saving === 'create'} disabled={needs !== null || saving !== null}>
            Create
          </Button>
          <Button
            variant="secondary"
            busy={saving === 'another'}
            disabled={needs !== null || saving !== null}
            onClick={() => void submit(true)}
          >
            Create and add another
          </Button>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {lead.map((field, index) => renderField(field, index === 0))}

        {/* A rail-created deal is already linked to the record it was opened from. */}
        {object === 'deal' && !onCreated ? (
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

        {needs ? <p className="text-small text-secondary">{needs}</p> : null}

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

        {rest.length > 0 ? (
          <section className="flex flex-col gap-3 border-t border-divider pt-3">
            <h3>
              <button
                type="button"
                aria-expanded={showMore}
                onClick={() => setShowMore(!showMore)}
                className="flex w-full items-center gap-2 text-left font-semibold"
              >
                {showMore ? (
                  <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
                ) : (
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
                )}
                More properties ({fmt.number(rest.length)})
                {restFilled > 0 ? (
                  <span className="text-small font-normal text-secondary">{fmt.number(restFilled)} filled</span>
                ) : null}
              </button>
            </h3>
            {showMore ? (
              <>
                <PropertySearch value={needle} onChange={setNeedle} />
                {matching.map((field) => renderField(field))}
                {query && matching.length === 0 ? (
                  <p className="text-secondary">No property matches “{needle.trim()}”.</p>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}

      </div>
    </SidePanel>
  )
}
