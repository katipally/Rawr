'use client'

import { Button, DiscardConfirm, Field, Select, TextInput, cn, useDismiss } from '@rawr/ui'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import type { AdminField, Conditional, FieldType, OptionRename } from '@rawr/db'
import { darkPill, lightPill } from '~/components/editor-bar.ts'
import { FilterBuilder, type FilterField, type Group } from '~/components/crm/filter-builder.tsx'
import { groupsComplete } from '~/components/crm/filter-rules.ts'
import { useFormat } from '~/components/zone.tsx'
import { pasteRows } from '~/lib/choices.ts'
import { errorMessage, trpc } from '~/lib/rpc.ts'
import { useUrlParam } from '~/lib/url-params.ts'

/** HubSpot's names for the field types, which are what a person picks from. */
export const TYPE_LABEL: Record<FieldType, string> = {
  text: 'Single-line text',
  long_text: 'Multi-line text',
  rich_text: 'Rich text',
  email: 'Email',
  phone: 'Phone number',
  url: 'URL',
  linkedin: 'LinkedIn URL',
  address: 'Address',
  number: 'Number',
  currency: 'Currency',
  percent: 'Percent',
  rating: 'Rating',
  select: 'Dropdown select',
  multi_select: 'Multiple checkboxes',
  boolean: 'Single checkbox',
  date: 'Date picker',
  datetime: 'Date and time picker',
  user: 'User',
  relation: 'Link to a record',
  json: 'JSON',
}

/** The registry knows all twenty; offering them in the order somebody thinks
 *  about them is a UI decision, so it lives here. */
const TYPE_GROUPS: { label: string; types: FieldType[] }[] = [
  { label: 'Text', types: ['text', 'long_text', 'rich_text', 'email', 'phone', 'url', 'linkedin', 'address'] },
  { label: 'Numbers', types: ['number', 'currency', 'percent', 'rating'] },
  { label: 'Choices', types: ['select', 'multi_select', 'boolean'] },
  { label: 'Dates', types: ['date', 'datetime'] },
  { label: 'Other', types: ['user', 'relation', 'json'] },
]

/** A relation has no target to pick from yet, so a new one could never hold a value.
 *  An existing one keeps the option, or its type would read as the first choice. */
const offered = (type: FieldType, field: AdminField | null): boolean => type !== 'relation' || field?.type === 'relation'

export const NEEDS_OPTIONS = new Set<FieldType>(['select', 'multi_select'])

/** A key is generated from the label once and then never changes, because renaming
 *  a label must never touch stored data. F0 §4. */
const keyFrom = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'f_$1')
    .slice(0, 59)

/** One row per choice. `origin` is the text the choice had when the editor opened,
 *  so a row that was typed over is a rename rather than a removal plus an addition. */
type Choice = { origin: string | null; value: string }

const choicesOf = (options: string[]): Choice[] => options.map((value) => ({ origin: value, value }))

export type PropertyDraft = {
  label: string
  key: string
  type: FieldType
  options: string[]
  renames: OptionRename[]
  helpText: string | null
  groupName: string | null
  conditional: Conditional | null
  isRequired: boolean
  trackChanges: boolean
}

const SECTIONS = [
  { key: 'details', label: 'Details', title: 'Add property details' },
  { key: 'fieldType', label: 'Field type', title: 'Choose a field type' },
  { key: 'rules', label: 'Rules', title: 'Property rules' },
  { key: 'usage', label: 'Usage', title: 'Usage' },
] as const
type Section = (typeof SECTIONS)[number]['key']

/** HubSpot's property editor: the whole window, the property and its object
 *  on a dark bar with Cancel and Save, and the parts of the definition as a
 *  rail of sections down the left. Which section is open is in the address. */
export const PropertyEditor = ({
  field,
  objectLabel,
  groups,
  filterFields,
  recordCount,
  busy,
  onSave,
  onClose,
}: {
  /** Null is a property being created. */
  field: AdminField | null
  objectLabel: string
  groups: string[]
  filterFields: FilterField[]
  recordCount: number
  busy: boolean
  onSave: (draft: PropertyDraft) => void
  onClose: () => void
}) => {
  const fmt = useFormat()
  const queryClient = useQueryClient()
  const [sectionParam, setSection] = useUrlParam('section')
  const sections = SECTIONS.filter((entry) => field || entry.key !== 'usage')
  const section: Section = sections.find((entry) => entry.key === sectionParam)?.key ?? 'details'

  const [label, setLabel] = useState(field?.label ?? '')
  const [key, setKey] = useState<string | null>(null)
  const [type, setType] = useState<FieldType>(field?.type ?? 'text')
  const [choices, setChoices] = useState<Choice[]>(() => choicesOf(field?.options ?? []))
  const [helpText, setHelpText] = useState(field?.helpText ?? '')
  const [groupName, setGroupName] = useState(field?.groupName ?? '')
  const [isRequired, setIsRequired] = useState(field?.isRequired ?? false)
  const [trackChanges, setTrackChanges] = useState(field?.trackChanges ?? false)
  const [conditional, setConditional] = useState<Conditional | null>(field?.conditional ?? null)
  const [usage, setUsage] = useState<{ usedIn: { kind: string; name: string }[]; usedInTotal: number } | null>(null)

  const ownKey = field?.key ?? key ?? keyFrom(label)
  const dirty = field
    ? label !== field.label ||
      JSON.stringify(choices) !== JSON.stringify(choicesOf(field.options)) ||
      helpText !== (field.helpText ?? '') ||
      groupName !== (field.groupName ?? '') ||
      isRequired !== field.isRequired ||
      trackChanges !== field.trackChanges ||
      JSON.stringify(conditional) !== JSON.stringify(field.conditional)
    : label !== '' || choices.length > 0 || helpText !== '' || groupName !== '' || conditional !== null
  const { asking, dismiss, keep, discard } = useDismiss(true, dirty, onClose)
  const conditionalComplete = groupsComplete(conditional ? [conditional] : [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dismiss])

  // What uses the property is a query per property, so it is asked for when the
  // section that shows it is opened rather than for every row of the list.
  useEffect(() => {
    if (!field || section !== 'usage' || usage) return
    queryClient
      .fetchQuery({ ...trpc.admin.fields.usage.queryOptions({ id: field.id }), staleTime: 0 })
      .then((found) => setUsage(found))
      .catch((cause) => setUsage({ usedIn: [{ kind: 'error', name: errorMessage(cause) }], usedInTotal: 1 }))
  }, [field, section, usage, queryClient])

  const save = () => {
    const kept = choices.map((choice) => ({ ...choice, value: choice.value.trim() })).filter((choice) => choice.value)
    onSave({
      label: label.trim(),
      key: ownKey,
      type,
      options: kept.map((choice) => choice.value),
      renames: kept.flatMap((choice) => (choice.origin !== null && choice.origin !== choice.value ? [{ from: choice.origin, to: choice.value }] : [])),
      helpText: helpText || null,
      groupName: groupName || null,
      conditional,
      isRequired,
      trackChanges,
    })
  }

  const title = SECTIONS.find((entry) => entry.key === section)!.title

  return (
    <div role="dialog" aria-modal="true" aria-label={field ? `Edit ${field.label}` : 'Create property'} className="fixed inset-0 z-overlay flex animate-pop-in flex-col bg-surface text-body motion-reduce:animate-none">
      <div inert={asking} className="flex min-h-0 flex-1 flex-col">
        <header className="grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 bg-nav px-2 text-nav-text sm:px-4">
          <span />
          <div className="flex min-w-0 flex-col items-center leading-tight">
            <h1 title={field?.label} className="max-w-[min(40rem,60vw)] truncate text-xl font-medium">{field ? field.label : 'Create property'}</h1>
            <p className="text-small font-semibold">{objectLabel}</p>
          </div>
          <div className="flex items-center gap-2 justify-self-end">
            <button type="button" onClick={dismiss} className={darkPill}>Cancel</button>
            <button type="button" disabled={busy || !label.trim() || !dirty || !conditionalComplete} onClick={save} className={lightPill}>
              {busy ? 'Saving' : field ? 'Save' : 'Create'}
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
          <nav aria-label="Property sections" className="shrink-0 border-b border-line px-4 py-4 md:w-60 md:overflow-y-auto md:border-r md:border-b-0 md:px-5 md:py-6">
            <h2 className="pb-2 font-semibold">Manage</h2>
            <ul className="flex gap-1 overflow-x-auto md:flex-col">
              {sections.map((entry) => (
                <li key={entry.key} className="shrink-0">
                  <button
                    type="button"
                    aria-current={section === entry.key ? 'page' : undefined}
                    onClick={() => setSection(entry.key === 'details' ? null : entry.key)}
                    className={cn(
                      'relative w-full rounded-hs px-3 py-[0.4375rem] text-left font-light transition-colors duration-150 ease-out',
                      section === entry.key ? 'bg-fill-hover before:absolute before:inset-y-0 before:left-0 before:w-1 before:rounded-l-hs before:bg-body' : 'hover:bg-fill',
                    )}
                  >
                    {entry.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0 flex-1 px-4 py-8 md:overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[30rem] flex-col gap-4">
              <h2 className="text-xl font-medium">{title}</h2>

              {section === 'details' ? (
                <>
                  <Field id="prop-label" label="Property label *" hint="What people see on the record.">
                    <TextInput id="prop-label" value={label} autoFocus onChange={(event) => setLabel(event.target.value)} />
                  </Field>
                  {field ? (
                    <p className="text-small text-secondary">
                      Internal name: <code className="break-all">{field.key}</code>
                    </p>
                  ) : (
                    <Field id="prop-key" label="Internal name" hint="Stored under this name, in imports and in the agent tools. Generated from the label, and it never changes afterwards.">
                      <TextInput id="prop-key" value={ownKey} onChange={(event) => setKey(event.target.value)} />
                    </Field>
                  )}
                  <Field id="prop-object" label="Object type">
                    <TextInput id="prop-object" value={objectLabel} disabled readOnly />
                  </Field>
                  <datalist id="property-groups">
                    {groups.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                  <Field id="prop-group" label="Group" hint="Optional. Properties with the same group are shown together.">
                    <TextInput id="prop-group" list="property-groups" value={groupName} placeholder="Group name" onChange={(event) => setGroupName(event.target.value)} />
                  </Field>
                  <Field id="prop-help" label="Description" hint="Optional. Shown under the input.">
                    <TextInput id="prop-help" value={helpText} onChange={(event) => setHelpText(event.target.value)} />
                  </Field>
                </>
              ) : null}

              {section === 'fieldType' ? (
                <>
                  <Field id="prop-type" label="Field type *" {...(field ? { hint: 'Fixed once the property exists: changing it would change what the stored values mean.' } : {})}>
                    <Select id="prop-type" value={type} disabled={field !== null} onChange={(event) => setType(event.target.value as FieldType)}>
                      {TYPE_GROUPS.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.types.filter((candidate) => offered(candidate, field)).map((candidate) => (
                            <option key={candidate} value={candidate}>
                              {TYPE_LABEL[candidate]}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </Select>
                  </Field>
                  {NEEDS_OPTIONS.has(type) ? (
                    <Field
                      id="prop-options"
                      label="Options"
                      hint={field ? 'Renaming a choice renames it on every record. A choice that records still use cannot be removed.' : 'One choice per row.'}
                    >
                      <div id="prop-options" className="flex flex-col gap-2">
                        {choices.map((choice, index) => (
                          <div key={index} className="flex items-center gap-2">
                            <TextInput
                              aria-label={`Choice ${index + 1}`}
                              value={choice.value}
                              onChange={(event) =>
                                setChoices(choices.map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry)))
                              }
                              onPaste={(event) => {
                                const { value, selectionStart, selectionEnd } = event.currentTarget
                                const rows = pasteRows(value, selectionStart ?? value.length, selectionEnd ?? value.length, event.clipboardData.getData('text'))
                                if (!rows) return
                                event.preventDefault()
                                const [first, ...more] = rows
                                setChoices(
                                  choices.flatMap((entry, at) =>
                                    at === index ? [{ ...entry, value: first }, ...more.map((row) => ({ origin: null, value: row }))] : [entry],
                                  ),
                                )
                              }}
                            />
                            <Button variant="tertiary" onClick={() => setChoices(choices.filter((_, at) => at !== index))}>
                              Remove
                            </Button>
                          </div>
                        ))}
                        <Button variant="secondary" onClick={() => setChoices([...choices, { origin: null, value: '' }])}>
                          Add choice
                        </Button>
                      </div>
                    </Field>
                  ) : null}
                </>
              ) : null}

              {section === 'rules' ? (
                <>
                  <Rule title="Validation options">
                    <Check checked={isRequired} onChange={setIsRequired} label="Required" hint="A record cannot be created without it. Existing records that lack it are untouched." />
                  </Rule>
                  <Rule title="History">
                    <Check
                      checked={trackChanges}
                      onChange={setTrackChanges}
                      label="Put changes on the timeline"
                      hint="Off by default. An import of 88,000 contacts would otherwise write a timeline entry per field per row."
                    />
                  </Rule>
                  <Rule title="Conditional logic">
                    <ConditionalEditor ownKey={ownKey} fields={filterFields} value={conditional} onChange={setConditional} />
                  </Rule>
                </>
              ) : null}

              {section === 'usage' && field ? (
                <>
                  <Rule title="Fill rate">
                    <p className="tabular-nums">
                      {field.filledCount === null
                        ? 'Not measured yet'
                        : recordCount === 0
                          ? 'No records yet'
                          : `${fmt.percent(field.filledCount / recordCount)}, ${fmt.number(field.filledCount)} of ${fmt.number(recordCount)} records`}
                    </p>
                    {field.filledAt ? <p className="text-small text-secondary">As of {fmt.date(field.filledAt)}</p> : null}
                  </Rule>
                  <Rule title={`Used in (${usage === null ? '...' : fmt.number(usage.usedInTotal)})`}>
                    {usage === null ? (
                      <p className="text-secondary">Looking...</p>
                    ) : usage.usedInTotal === 0 ? (
                      <p className="text-secondary">Nothing uses this property.</p>
                    ) : (
                      <>
                        <ul className="flex flex-col gap-1">
                          {usage.usedIn.map((use) => (
                            <li key={`${use.kind}:${use.name}`} className="break-words">
                              {use.name} <span className="text-secondary">({use.kind})</span>
                            </li>
                          ))}
                        </ul>
                        {usage.usedInTotal > usage.usedIn.length ? (
                          <p className="text-secondary">and {fmt.number(usage.usedInTotal - usage.usedIn.length)} more</p>
                        ) : null}
                      </>
                    )}
                  </Rule>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {asking ? <DiscardConfirm onKeep={keep} onDiscard={discard} /> : null}
    </div>
  )
}

const Rule = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h3 className="text-lg font-medium">{title}</h3>
    {children}
  </section>
)

const Check = ({ checked, onChange, label, hint }: { checked: boolean; onChange: (next: boolean) => void; label: string; hint: string }) => (
  <label className="flex items-start gap-2">
    <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1" />
    <span>
      {label}
      <span className="block text-small text-secondary">{hint}</span>
    </span>
  </label>
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

  if (others.length === 0) return <p className="text-secondary">There is no other property to depend on.</p>

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={open}
          className="mt-1"
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
          singleGroup
          onChange={(groups) => onChange(groups[0] ?? null)}
        />
      ) : null}
    </div>
  )
}
