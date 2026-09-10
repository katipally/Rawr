'use client'

import { Field, Select } from '@rawr/ui'
import { useState } from 'react'

export type ImportKindOption = {
  value: string
  label: string
  /** What the file is, in one sentence. */
  what: string
  /** The columns this kind is mapped against, in the labels the mapper shows.
   *  Empty for a record file, whose columns are the object's own fields. */
  columns: string[]
  /** The ones the mapper refuses to start without. */
  required: string[]
}

/** The kind picker, and what the chosen kind expects.
 *
 *  The five shape files are mapped against a fixed set of columns, and until now
 *  the only place that said so was the mapper, which is one upload too late: a
 *  file of list memberships with no email column was picked, uploaded, parsed and
 *  then refused. The columns come from the shapes themselves rather than from a
 *  sentence somebody typed, so they cannot drift from what the mapper enforces. */
export const ImportKindField = ({ options }: { options: ImportKindOption[] }) => {
  const [value, setValue] = useState(options[0]?.value ?? '')
  const chosen = options.find((option) => option.value === value) ?? options[0]

  return (
    <Field id="import-object" label="What is in the file">
      <Select
        id="import-object"
        name="object"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      {chosen ? (
        <div className="flex min-w-0 flex-col gap-1 text-secondary">
          <p>{chosen.what}</p>
          {chosen.columns.length > 0 ? (
            <p className="break-words">
              Columns: {chosen.columns.join(', ')}.{' '}
              {chosen.required.length > 0
                ? `${chosen.required.join(' and ')} must be mapped; the rest are optional.`
                : ''}
            </p>
          ) : null}
        </div>
      ) : null}
    </Field>
  )
}
