'use client'

import { useId } from 'react'
import { cn } from '../cn.ts'

export type DatePickerProps = {
  label: string
  /** ISO date, yyyy-mm-dd, or null for empty. Times are handled separately, because
   *  a close date is a date and a meeting is an instant. */
  value: string | null
  onChange: (next: string | null) => void
  min?: string
  max?: string
  error?: string
  disabled?: boolean
}

export const DatePicker = ({
  label,
  value,
  onChange,
  min,
  max,
  error,
  disabled,
}: DatePickerProps) => {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={id}
          type="date"
          value={value ?? ''}
          min={min}
          max={max}
          disabled={disabled}
          aria-invalid={error !== undefined}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          className={cn(
            'min-h-9 w-full min-w-0 rounded-hs border border-line bg-fill px-3 outline-none',
            'focus:border-line-interactive focus:bg-surface',
            'disabled:bg-disabled disabled:text-secondary',
            error && 'border-error',
          )}
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="shrink-0 rounded-hs px-2 py-1 text-secondary hover:bg-fill-hover"
          >
            Clear
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
