'use client'

import { cn } from '@rawr/ui'

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

/** The kind picker as HubSpot's object tiles, and what the chosen kind expects.
 *
 *  The five shape files are mapped against a fixed set of columns, and until now
 *  the only place that said so was the mapper, which is one upload too late: a
 *  file of list memberships with no email column was picked, uploaded, parsed and
 *  then refused. The columns come from the shapes themselves rather than from a
 *  sentence somebody typed, so they cannot drift from what the mapper enforces. */
export const ImportKindField = ({
  options,
  value,
  onChange,
}: {
  options: ImportKindOption[]
  value: string
  onChange: (value: string) => void
}) => {
  const chosen = options.find((option) => option.value === value) ?? options[0]

  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-3 text-base font-semibold">What is in the file</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map((option) => {
          const on = option.value === chosen?.value
          return (
            <label
              key={option.value}
              className={cn(
                'flex min-w-0 cursor-pointer items-start gap-3 rounded-hs border p-3 transition-colors duration-150 ease-out',
                on ? 'border-tooltip bg-canvas' : 'border-line-strong bg-surface hover:bg-fill',
              )}
            >
              <input
                type="radio"
                name="object"
                value={option.value}
                checked={on}
                onChange={() => onChange(option.value)}
                className="mt-1 shrink-0"
              />
              <span className="min-w-0 break-words font-semibold">{option.label}</span>
            </label>
          )
        })}
      </div>
      {chosen ? (
        <div className="flex min-w-0 flex-col gap-1 text-secondary" aria-live="polite">
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
    </fieldset>
  )
}
