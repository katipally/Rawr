'use client'

import { useId, useState } from 'react'

export type TagInputProps = {
  label: string
  values: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  /** Rejecting a value returns the reason, which is shown rather than swallowed. */
  validate?: (value: string) => string | null
}

export const TagInput = ({
  label,
  values,
  onChange,
  placeholder = 'Add and press Enter',
  validate,
}: TagInputProps) => {
  const id = useId()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = () => {
    const candidate = draft.trim()
    if (candidate === '') return
    if (values.includes(candidate)) {
      setError(`${candidate} is already there.`)
      return
    }
    const reason = validate?.(candidate) ?? null
    if (reason) {
      setError(reason)
      return
    }
    onChange([...values, candidate])
    setDraft('')
    setError(null)
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-1 rounded-hs border border-line bg-fill p-1 focus-within:border-line-interactive">
        {values.map((value) => (
          <span
            key={value}
            className="flex max-w-full min-w-0 items-center gap-1 rounded-hs bg-accent-subtle px-2 py-0.5"
          >
            <span className="truncate">{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((v) => v !== value))}
              className="shrink-0 text-secondary"
            >
              ✕
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          placeholder={values.length === 0 ? placeholder : ''}
          aria-invalid={error !== null}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
            if (event.key === 'Backspace' && draft === '' && values.length > 0) {
              onChange(values.slice(0, -1))
            }
          }}
          onBlur={add}
          className="min-h-7 min-w-24 flex-1 bg-transparent px-2 outline-none"
        />
      </div>
      {error ? (
        <p role="alert" className="text-error">
          {error}
        </p>
      ) : null}
    </div>
  )
}
