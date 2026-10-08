'use client'

import { Button, Card, Checkbox, Field, Select } from '@rawr/ui'
import { useState } from 'react'
import { exportCsvPath } from '~/lib/links.ts'

export type ExportObject = {
  key: string
  label: string
  fields: { key: string; label: string }[]
  views: {
    slug: string
    name: string
    columns: string[]
    /** Serialised the way the CSV route parses them, so this component never
     *  has to know what a filter is. */
    filters: string
    sort: string | null
  }[]
}

export type ExportPickerProps = {
  account: string
  objects: ExportObject[]
  /** The object the person was on when they opened the page. Unknown keys fall back to the first object. */
  initialObject?: string | undefined
}

/** Empty, because a view's slug never is, and "all" is a real slug: the default
 *  view is /views/all, so sharing that value made the two options collide and the
 *  picker opened on the view rather than on every field. */
const ALL_FIELDS = ''

/** Which properties the file carries, in HubSpot's three choices: the view's
 *  columns, every property, or a hand-picked set. */
type Include = 'view' | 'all' | 'choose'

/** Picks what a CSV holds, laid out as HubSpot's export dialog. The download
 *  itself is a plain link so the browser owns it: the file keeps arriving after
 *  this tab is closed, and a slow export never blocks the page it started from. */
export const ExportPicker = ({ account, objects, initialObject }: ExportPickerProps) => {
  const [objectKey, setObjectKey] = useState(objects.find((candidate) => candidate.key === initialObject)?.key ?? objects[0]?.key ?? '')
  const object = objects.find((candidate) => candidate.key === objectKey) ?? objects[0]
  const [viewSlug, setViewSlug] = useState(ALL_FIELDS)
  const [include, setInclude] = useState<Include>('all')
  const [picked, setPicked] = useState<string[]>([])

  if (!object) return null

  const view = object.views.find((candidate) => candidate.slug === viewSlug)
  const every = object.fields.map((field) => field.key)
  const columns = include === 'choose' ? picked : include === 'view' && view ? view.columns : every
  const chosen = new Set(columns)

  const reset = (next: { object?: string; view?: string }) => {
    if (next.object !== undefined) {
      setObjectKey(next.object)
      setViewSlug(ALL_FIELDS)
      setInclude('all')
    }
    if (next.view !== undefined) {
      setViewSlug(next.view)
      setInclude(next.view === ALL_FIELDS ? 'all' : 'view')
    }
    setPicked([])
  }

  const choose = () => {
    // Starts from what was about to be exported, so ticking one more column is
    // one click rather than rebuilding the list.
    setPicked(columns)
    setInclude('choose')
  }

  const toggle = (key: string, on: boolean) => {
    // Kept in the object's own field order rather than the order they were
    // ticked, so the CSV's columns read the way the record page does.
    const next = new Set(chosen)
    if (on) next.add(key)
    else next.delete(key)
    setPicked(object.fields.filter((field) => next.has(field.key)).map((field) => field.key))
  }

  const href = exportCsvPath(account, {
    object: object.key,
    columns: columns.join(','),
    // A view exports what it shows. Without these the header's promise of "its
    // filters, its columns, its order" was one third true.
    ...(view && view.filters !== '[]' ? { filters: view.filters } : {}),
    ...(view?.sort ? { sort: view.sort } : {}),
  })

  const choices: { value: Include; label: string; hint: string }[] = [
    ...(view ? [{ value: 'view' as const, label: 'Only properties in the view', hint: `The ${view.name} columns, in its order.` }] : []),
    { value: 'all', label: 'All properties', hint: `Every property ${object.label.toLowerCase()} have, ${object.fields.length} in all.` },
    { value: 'choose', label: 'Choose properties', hint: 'Tick the columns the file should carry.' },
  ]

  return (
    <div className="mx-auto flex w-full max-w-[40rem] min-w-0 flex-col gap-4">
      <section className="flex min-w-0 flex-col gap-5 rounded-panel border border-line bg-surface p-6 shadow-panel">
        <h2 className="text-xl font-medium">Export {object.label.toLowerCase()}</h2>

        <Field id="export-object" label="Object">
          <Select id="export-object" value={object.key} onChange={(event) => reset({ object: event.target.value })}>
            {objects.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>
                {candidate.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          id="export-view"
          label="Records"
          hint={view ? 'The rows the view holds, filtered and sorted as it is.' : 'Every record of this object.'}
        >
          <Select id="export-view" value={viewSlug} onChange={(event) => reset({ view: event.target.value })}>
            <option value={ALL_FIELDS}>Every record</option>
            {object.views.map((candidate) => (
              <option key={candidate.slug} value={candidate.slug}>
                {candidate.name}
              </option>
            ))}
          </Select>
        </Field>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 font-semibold">Properties included in the export</legend>
          {choices.map((choice) => (
            <label key={choice.value} className="flex min-w-0 cursor-pointer items-start gap-2">
              <input
                type="radio"
                name="export-include"
                checked={include === choice.value}
                onChange={() => (choice.value === 'choose' ? choose() : setInclude(choice.value))}
                className="mt-1 shrink-0"
              />
              <span className="flex min-w-0 flex-col">
                <span>{choice.label}</span>
                <span className="text-small text-secondary">{choice.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <Field id="export-format" label="File format">
          <Select id="export-format" value="csv" disabled>
            <option value="csv">CSV</option>
          </Select>
        </Field>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            className="min-h-[2.4375rem] px-6 text-[length:var(--rawr-text-body)] font-semibold"
            disabled={columns.length === 0}
            onClick={() => {
              if (columns.length > 0) window.location.assign(href)
            }}
          >
            Export
          </Button>
          <span className="text-secondary">
            {columns.length === 0
              ? 'Pick at least one column.'
              : `${columns.length} column${columns.length === 1 ? '' : 's'}`}
            {view && view.filters !== '[]' ? ', filtered as the view is' : ''}
          </span>
        </div>
      </section>

      {include === 'choose' ? (
        <Card
          title="Columns"
          className="min-w-0"
          action={
            <div className="flex gap-1">
              <Button variant="tertiary" onClick={() => setPicked(every)}>
                All
              </Button>
              <Button variant="tertiary" onClick={() => setPicked([])}>
                None
              </Button>
            </div>
          }
        >
          <div className="grid gap-1.5 @md:grid-cols-2">
            {object.fields.map((field) => (
              <Checkbox
                key={field.key}
                label={field.label}
                checked={chosen.has(field.key)}
                onChange={(event) => toggle(field.key, event.target.checked)}
              />
            ))}
          </div>
        </Card>
      ) : null}
    </div>
  )
}
