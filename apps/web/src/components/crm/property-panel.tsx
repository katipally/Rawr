'use client'

import { matchesConditional } from '@rawr/db/registry'
import { Button, IconButton, cn, useToast } from '@rawr/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorCode, errorMessage } from '~/lib/rpc.ts'
import { ACTION_ICONS } from '~/components/icons.ts'
import { FieldInput, scoped, type EditableField } from './field-input.tsx'
import { PropertySearch } from './property-search.tsx'
import { type PanelSync, editKeyAction, readArrived, reloadRequested } from './property-sync.ts'
import { EMPTY_VALUE, Value } from './value.tsx'
import { useFormat } from '~/components/zone.tsx'

export type PropertySection = {
  title: string
  fieldKeys: string[]
  /** Kept behind "All properties" rather than open on the card. */
  secondary?: boolean
}

export type PropertyPanelProps = {
  object: string
  recordId: string
  fields: EditableField[]
  values: Record<string, unknown>
  labels: Record<string, string>
  updatedAt: string
  sections: PropertySection[]
  canWrite: boolean
}

/** Click a value to edit it. Optimistic with rollback: the typed value shows
 *  immediately, and a refused save puts the old one back with the reason beside
 *  it rather than silently discarding what was typed. A6. */
export const PropertyPanel = ({
  object,
  recordId,
  fields,
  values,
  labels,
  updatedAt,
  sections,
  canWrite,
}: PropertyPanelProps) => {
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const [local, setLocal] = useState(values)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<unknown>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [showAll, setShowAll] = useState(false)
  const [needle, setNeedle] = useState('')
  // A save is refused only if the field being edited has changed on the server
  // since its base was read, not the whole record.
  const [sync, setSync] = useState<PanelSync>({ base: null, reloading: null, errors: {} })
  const [seen, setSeen] = useState(updatedAt)
  const [seenValues, setSeenValues] = useState(values)

  /** The panel edits a copy so a field can show its new value before the server
   *  answers. That copy has to give way when the record changes underneath it:
   *  a merge, an accepted enrichment, a bulk edit. Otherwise the panel shows values
   *  that are no longer stored. */
  if (updatedAt !== seen) {
    setSeen(updatedAt)
    setLocal(values)
  }
  if (values !== seenValues) {
    setSeenValues(values)
    setSync((current) => readArrived(current, values, labels))
  }

  const byKey = new Map(fields.map((field) => [field.key, field]))

  const cancel = (key: string) => {
    setEditing(null)
    setSync((current) => {
      const { [key]: _dropped, ...errors } = current.errors
      return { ...current, errors }
    })
  }

  const save = async (field: EditableField) => {
    const previous = local[field.key]
    const next = draft
    if (String(next ?? '') === String(previous ?? '')) {
      setEditing(null)
      return
    }

    setSaving(field.key)
    setLocal((current) => ({ ...current, [field.key]: next }))
    setSync((current) => {
      const { [field.key]: _dropped, ...errors } = current.errors
      return { ...current, errors }
    })

    try {
      const result = await api.crm.records.update.mutate({
        object,
        id: recordId,
        values: { [field.key]: next === '' ? null : next },
        expectedValues: { [field.key]: sync.base },
      })
      for (const warning of result.warnings) toast('info', warning)
      setEditing(null)
      // The timeline and the rail read from the server, so a saved change has to
      // reach them too.
      router.refresh()
    } catch (cause) {
      const conflict = errorCode(cause) === 'CONFLICT'
      setLocal((current) => ({ ...current, [field.key]: previous }))
      setSync((current) => ({
        ...current,
        errors: {
          ...current.errors,
          [field.key]: {
            message: conflict ? `${errorMessage(cause)} What you typed was “${String(next ?? '')}”.` : errorMessage(cause),
            conflict,
          },
        },
      }))
    } finally {
      setSaving(null)
    }
  }

  /** Conditional property logic, applied in the one place the panel decides
   *  what to draw. A property whose rule does not match the values on screen
   *  is not on the record; it comes back the moment the rule matches, and
   *  whatever it already held is untouched either way. */
  const shownIn = (section: PropertySection): EditableField[] =>
    section.fieldKeys.flatMap((key) => {
      const field = byKey.get(key)
      if (!field) return []
      return matchesConditional(field.conditional, local) ? [field] : []
    })

  const primary = sections.filter((section) => !section.secondary)
  const secondary = sections.filter((section) => section.secondary)
  const secondaryCount = secondary.reduce((sum, section) => sum + shownIn(section).length, 0)
  const query = needle.trim().toLowerCase()
  // A section's own title counts as a match, so typing a group name lists the group.
  const matching = secondary.flatMap((section) => {
    const fieldKeys = shownIn(section)
      .filter((field) => !query || field.label.toLowerCase().includes(query) || section.title.toLowerCase().includes(query))
      .map((field) => field.key)
    return fieldKeys.length > 0 ? [{ ...section, fieldKeys }] : []
  })

  const renderSection = (section: PropertySection, forceOpen: boolean) => {
    const isCollapsed = !forceOpen && collapsed[section.title] === true
    const sectionFields = shownIn(section)
    if (sectionFields.length === 0) return null

    return (
      <section key={section.title} className="rounded-panel border border-line bg-surface shadow-panel">
        <h2 className={cn('px-6 pt-6', isCollapsed ? 'pb-6' : 'pb-4')}>
          <button
            type="button"
            aria-expanded={!isCollapsed}
            onClick={() =>
              setCollapsed((current) => ({ ...current, [section.title]: !isCollapsed }))
            }
            className="flex w-full items-center gap-2 text-left text-base font-semibold"
          >
            {isCollapsed ? (
              <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
            ) : (
              <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
            )}
            {/* A group name is typed by an admin and nothing caps its length.
                Without this a long one pushes the panel wider than its column
                rather than ending in an ellipsis. */}
            <span className="min-w-0 truncate" title={section.title}>
              {section.title}
            </span>
          </button>
        </h2>

        {isCollapsed ? null : (
          <dl className="flex flex-col gap-4 px-6 pb-6">
            {sectionFields.map((field) => {
              const isEditing = editing === field.key
              const error = sync.errors[field.key]
              const editable = canWrite && !field.readOnly

              // A note is written to be read, and the value column of a
              // two-column panel is about ten characters wide. So rich text
              // stacks: the label on its own line and the note under it,
              // using the whole panel. Every other type stays in the grid,
              // where a label beside its value is what makes the panel
              // scannable.
              return (
                <div key={field.key} className="flex min-w-0 flex-col">
                  <dt className="min-w-0 text-small text-secondary">{field.label}</dt>
                  <dd className="min-w-0">
                    {isEditing ? (
                      <fieldset
                        aria-label={field.label}
                        className="flex min-w-0 flex-col gap-1"
                        onKeyDown={(event) => {
                          if (event.defaultPrevented) return
                          const keepsEnter =
                            field.type === 'rich_text' || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLButtonElement
                          const action = editKeyAction(event.key, { keepsEnter, composing: event.nativeEvent.isComposing })
                          if (action === 'cancel') {
                            event.preventDefault()
                            cancel(field.key)
                          } else if (action === 'save' && saving !== field.key) {
                            event.preventDefault()
                            void save(field)
                          }
                        }}
                      >
                        <FieldInput
                          id={`edit-${field.key}`}
                          field={scoped(field, local)}
                          value={draft}
                          valueLabel={labels[field.key]}
                          autoFocus
                          onChange={setDraft}
                        />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="primary"
                            busy={saving === field.key}
                            onClick={() => void save(field)}
                          >
                            Save
                          </Button>
                          <Button
                            variant="tertiary"
                            onClick={() => cancel(field.key)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </fieldset>
                    ) : field.type === 'rich_text' ? (
                      // Its own shape, because the click-to-edit affordance
                      // below is a <button>, and a formatted note is blocks
                      // and links. Neither is valid inside one, and a link
                      // inside a button cannot be followed anyway. So the
                      // note is read as itself and the pencil sits beside it.
                      <div className="flex min-w-0 items-start gap-1">
                        <div className="min-w-0 flex-1 px-1.5 py-0.5">
                          <Value format={fmt}
                            type={field.type}
                            value={local[field.key]}
                            label={labels[field.key]}
                            placeholder={EMPTY_VALUE}
                          />
                        </div>
                        {editable ? (
                          <IconButton
                            label={`Edit ${field.label}`}
                            icon={<ACTION_ICONS.edit size={16} />}
                            onClick={() => {
                              setEditing(field.key)
                              setSync((current) => ({ ...current, base: local[field.key] }))
                              setDraft(local[field.key] ?? '')
                            }}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={!editable}
                        aria-label={editable ? `Edit ${field.label}` : field.label}
                        onClick={() => {
                          setEditing(field.key)
                          setSync((current) => ({ ...current, base: local[field.key] }))
                          setDraft(local[field.key] ?? '')
                        }}
                        className={cn(
                          'group -mx-1.5 w-[calc(100%+0.75rem)] min-w-0 rounded-hs border border-transparent px-1.5 py-0.5 text-left',
                          editable && 'hover:border-line hover:bg-fill',
                          !editable && 'cursor-default',
                        )}
                      >
                        <Value format={fmt}
                          type={field.type}
                          value={local[field.key]}
                          label={labels[field.key]}
                          currency={local.currency}
                          placeholder={EMPTY_VALUE}
                        />
                        {editable ? (
                          <span
                            aria-hidden="true"
                            className="ml-1 text-secondary no-underline opacity-0 group-hover:opacity-100"
                          >
                            ✎
                          </span>
                        ) : null}
                      </button>
                    )}

                    {error ? (
                      <div className="flex min-w-0 flex-col items-start gap-2">
                        <p role="alert" className="min-w-0 break-words text-error">
                          {error.message}
                        </p>
                        {error.conflict ? (
                          <Button
                            variant="secondary"
                            onClick={() => {
                              setSync((current) => reloadRequested(current, field.key))
                              router.refresh()
                            }}
                          >
                            Reload
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </dd>
                </div>
              )
            })}
          </dl>
        )}
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {primary.map((section) => renderSection(section, false))}
      {secondary.length > 0 ? (
        <section className="rounded-panel border border-line bg-surface shadow-panel">
          <h2 className={cn('px-6 pt-6', showAll ? 'pb-4' : 'pb-6')}>
            <button
              type="button"
              aria-expanded={showAll}
              onClick={() => setShowAll(!showAll)}
              className="flex w-full items-center gap-2 text-left text-base font-semibold"
            >
              {showAll ? (
                <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
              ) : (
                <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
              )}
              All properties ({fmt.number(secondaryCount)})
            </button>
          </h2>
          {showAll ? (
            <PropertySearch value={needle} onChange={setNeedle} className="mx-6 mb-6" />
          ) : null}
        </section>
      ) : null}
      {showAll ? matching.map((section) => renderSection(section, query !== '')) : null}
      {showAll && query !== '' && matching.length === 0 ? (
        <p className="px-2 text-secondary">No property matches “{needle.trim()}”.</p>
      ) : null}
    </div>
  )
}
