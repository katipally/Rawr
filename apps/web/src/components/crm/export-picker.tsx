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
}

/** Empty, because a view's slug never is, and "all" is a real slug: the default
 *  view is /views/all, so sharing that value made the two options collide and the
 *  picker opened on the view rather than on every field. */
const ALL_FIELDS = ''

/** Picks what a CSV holds. The download itself is a plain link so the browser
 *  owns it: the file keeps arriving after this tab is closed, and a slow export
 *  never blocks the page it started from. */
export const ExportPicker = ({ account, objects }: ExportPickerProps) => {
  const [objectKey, setObjectKey] = useState(objects[0]?.key ?? '')
  const object = objects.find((candidate) => candidate.key === objectKey) ?? objects[0]
  const [viewSlug, setViewSlug] = useState(ALL_FIELDS)
  // Null means "whatever the chosen starting point says", so switching object or
  // view does not have to guess whether the person had edited the list yet.
  const [picked, setPicked] = useState<string[] | null>(null)

  if (!object) return null

  const startingColumns =
    viewSlug === ALL_FIELDS
      ? object.fields.map((field) => field.key)
      : (object.views.find((view) => view.slug === viewSlug)?.columns ?? [])
  const columns = picked ?? startingColumns
  const chosen = new Set(columns)

  const reset = (next: { object?: string; view?: string }) => {
    if (next.object !== undefined) {
      setObjectKey(next.object)
      setViewSlug(ALL_FIELDS)
    }
    if (next.view !== undefined) setViewSlug(next.view)
    setPicked(null)
  }

  const toggle = (key: string, on: boolean) => {
    // Kept in the object's own field order rather than the order they were
    // ticked, so the CSV's columns read the way the record page does.
    const next = new Set(chosen)
    if (on) next.add(key)
    else next.delete(key)
    setPicked(object.fields.filter((field) => next.has(field.key)).map((field) => field.key))
  }

  const view = object.views.find((candidate) => candidate.slug === viewSlug)
  const href = exportCsvPath(account, {
    object: object.key,
    columns: columns.join(','),
    // A view exports what it shows. Without these the header's promise of "its
    // filters, its columns, its order" was one third true.
    ...(view && view.filters !== '[]' ? { filters: view.filters } : {}),
    ...(view?.sort ? { sort: view.sort } : {}),
  })

  return (
    <div className="flex flex-col gap-4 @2xl:flex-row @2xl:items-start">
      <Card title="What to export" className="min-w-0 flex-1">
        <div className="flex flex-col gap-3">
          <Field id="export-object" label="Object">
            <Select
              id="export-object"
              value={object.key}
              onChange={(event) => reset({ object: event.target.value })}
            >
              {objects.map((candidate) => (
                <option key={candidate.key} value={candidate.key}>
                  {candidate.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            id="export-view"
            label="Columns from"
            hint={
              view
                ? 'The view’s columns, its filters and its order.'
                : 'Every field this object has, and every row.'
            }
          >
            <Select
              id="export-view"
              value={viewSlug}
              onChange={(event) => reset({ view: event.target.value })}
            >
              <option value={ALL_FIELDS}>Every field</option>
              {object.views.map((candidate) => (
                <option key={candidate.slug} value={candidate.slug}>
                  {candidate.name}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={columns.length === 0}
              onClick={() => {
                if (columns.length > 0) window.location.assign(href)
              }}
            >
              Download CSV
            </Button>
            <span className="text-secondary">
              {columns.length === 0
                ? 'Pick at least one column.'
                : `${columns.length} column${columns.length === 1 ? '' : 's'}`}
              {view && view.filters !== '[]' ? ', filtered as the view is' : ''}
            </span>
          </div>
        </div>
      </Card>

      <Card
        title="Columns"
        className="min-w-0 flex-1"
        action={
          <div className="flex gap-1">
            <Button
              variant="tertiary"
              onClick={() => setPicked(object.fields.map((field) => field.key))}
            >
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
    </div>
  )
}
