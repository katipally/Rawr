'use client'

import { Button, IconButton, cn, useToast } from '@rawr/ui'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorCode, errorMessage } from '~/lib/rpc.ts'
import { ACTION_ICONS } from '~/components/icons.ts'
import { FieldInput, scoped, type EditableField } from './field-input.tsx'
import { Value } from './value.tsx'
import { useZone } from '~/components/zone.tsx'

export type PropertySection = { title: string; fieldKeys: string[] }

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
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [local, setLocal] = useState(values)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<unknown>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [stamp, setStamp] = useState(updatedAt)
  const [seen, setSeen] = useState(updatedAt)

  /** The panel edits a copy so a field can show its new value before the server
   *  answers. That copy has to give way when the record changes underneath it —
   *  a merge, an accepted enrichment, a bulk edit — or the panel shows values
   *  that are no longer stored, and `stamp` goes stale enough that the next
   *  inline edit is refused as a conflict with a change this panel made itself. */
  if (updatedAt !== seen) {
    setSeen(updatedAt)
    setLocal(values)
    setStamp(updatedAt)
  }

  const byKey = new Map(fields.map((field) => [field.key, field]))

  const save = async (field: EditableField) => {
    const previous = local[field.key]
    const next = draft
    if (String(next ?? '') === String(previous ?? '')) {
      setEditing(null)
      return
    }

    setSaving(field.key)
    setLocal((current) => ({ ...current, [field.key]: next }))
    setErrors((current) => {
      const { [field.key]: _dropped, ...rest } = current
      return rest
    })

    try {
      const result = await api.crm.records.update.mutate({
        object,
        id: recordId,
        values: { [field.key]: next === '' ? null : next },
        expectedUpdatedAt: new Date(stamp),
      })
      for (const warning of result.warnings) toast('info', warning)
      setStamp(result.updatedAt.toISOString())
      setEditing(null)
      // The timeline and the rail read from the server, so a saved change has to
      // reach them too.
      router.refresh()
    } catch (cause) {
      setLocal((current) => ({ ...current, [field.key]: previous }))
      const message = errorMessage(cause)
      setErrors((current) => ({
        ...current,
        [field.key]:
          errorCode(cause) === 'CONFLICT'
            ? `${message} What you typed was “${String(next ?? '')}”.`
            : message,
      }))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {sections.map((section) => {
        const isCollapsed = collapsed[section.title] === true
        const sectionFields = section.fieldKeys.flatMap((key) => {
          const field = byKey.get(key)
          return field ? [field] : []
        })
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
                  const error = errors[field.key]
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
                          <div className="flex flex-col gap-1">
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
                                onClick={() => {
                                  setEditing(null)
                                  setErrors((current) => {
                                    const { [field.key]: _dropped, ...rest } = current
                                    return rest
                                  })
                                }}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : field.type === 'rich_text' ? (
                          // Its own shape, because the click-to-edit affordance
                          // below is a <button>, and a formatted note is blocks
                          // and links. Neither is valid inside one, and a link
                          // inside a button cannot be followed anyway. So the
                          // note is read as itself and the pencil sits beside it.
                          <div className="flex min-w-0 items-start gap-1">
                            <div className="min-w-0 flex-1 px-1.5 py-0.5">
                              <Value zone={zone}
                                type={field.type}
                                value={local[field.key]}
                                label={labels[field.key]}
                                placeholder="—"
                              />
                            </div>
                            {editable ? (
                              <IconButton
                                label={`Edit ${field.label}`}
                                icon={<ACTION_ICONS.edit size={16} />}
                                onClick={() => {
                                  setEditing(field.key)
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
                              setDraft(local[field.key] ?? '')
                            }}
                            className={cn(
                              'group -mx-1.5 w-[calc(100%+0.75rem)] min-w-0 rounded-hs border border-transparent px-1.5 py-0.5 text-left',
                              editable && 'hover:border-line hover:bg-fill',
                              !editable && 'cursor-default',
                            )}
                          >
                            <Value zone={zone}
                              type={field.type}
                              value={local[field.key]}
                              label={labels[field.key]}
                              currency={String(local.currency ?? 'USD')}
                              placeholder="—"
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
                          <p role="alert" className="text-error">
                            {error}
                          </p>
                        ) : null}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            )}
          </section>
        )
      })}
    </div>
  )
}
