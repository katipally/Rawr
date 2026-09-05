'use client'

import { cn } from '@rawr/ui'
import { useEffect, useId, useRef, useState } from 'react'
import { api } from '~/lib/rpc.ts'

export type PickedRecord = { id: string; label: string; detail?: string | null }

export type RecordPickerProps = {
  /** An object key, core or invented. */
  object: string
  /** What is chosen now, so the control can show a name rather than a uuid. */
  value: PickedRecord | null
  onChange: (next: PickedRecord | null) => void
  label: string
  /** Never offer this record, e.g. the record being merged into. */
  excludeId?: string | null
  disabled?: boolean
  /** Shown when nothing is chosen. */
  placeholder?: string
  /** Hides the clear button where the field is required. */
  allowClear?: boolean
  id?: string
}

const DEBOUNCE_MS = 200

/** A record picker that asks the server instead of holding the object in memory.
 *
 *  Every picker in the app used to be a select element filled from a capped list —
 *  the first 500 companies, the 200 newest contacts. Against the real portal that
 *  hides most records permanently: you cannot file a contact under a company whose
 *  name sorts late, and you cannot merge a duplicate that is not recent. So the
 *  list is a query, keyed on what has been typed, capped at a screenful, and the
 *  cap is honest because the search is what narrows it. */
export const RecordPicker = ({
  object,
  value,
  onChange,
  label,
  excludeId = null,
  disabled = false,
  placeholder = 'Search by name',
  allowClear = true,
  id,
}: RecordPickerProps) => {
  const generated = useId()
  const inputId = id ?? generated
  const listId = `${inputId}-list`

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [options, setOptions] = useState<PickedRecord[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  // One request per pause in typing, and a later answer never overwrites an
  // earlier one for a query the person has already moved on from.
  useEffect(() => {
    if (!open) return
    let live = true
    setLoading(true)
    const timer = setTimeout(() => {
      api.crm.records.options
        .query({ object, query, excludeId })
        .then((rows) => {
          if (!live) return
          setOptions(rows)
          setActive(0)
          setProblem(null)
        })
        .catch((cause: unknown) => {
          if (!live) return
          setOptions([])
          setProblem(cause instanceof Error ? cause.message : 'That search could not be run.')
        })
        .finally(() => {
          if (live) setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [object, query, excludeId, open])

  // Clicking anywhere else closes the list. Escape does too, further down.
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const choose = (option: PickedRecord) => {
    onChange(option)
    setOpen(false)
    setQuery('')
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      setActive((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1
        if (options.length === 0) return 0
        return (next + options.length) % options.length
      })
      return
    }
    if (event.key === 'Enter' && open) {
      const option = options[active]
      if (option) {
        event.preventDefault()
        choose(option)
      }
    }
  }

  return (
    <div ref={box} className="relative flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={label}
          disabled={disabled}
          value={open ? query : (value?.label ?? '')}
          placeholder={value ? value.label : placeholder}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onKeyDown={onKeyDown}
          className="w-full min-w-0 rounded-hs border border-line bg-surface px-2 py-1 disabled:bg-disabled"
        />
        {allowClear && value && !disabled ? (
          <button
            type="button"
            onClick={() => {
              onChange(null)
              setQuery('')
            }}
            className="shrink-0 text-small text-link"
          >
            Clear
          </button>
        ) : null}
      </div>

      {/* A listbox holds options, not list items. This was a <ul> of <li> each
          wrapping a role="option" button, so the options were not children of the
          listbox at all and the list semantics fought the widget semantics. The
          options are the buttons, and they sit directly inside now. */}
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute top-full right-0 left-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-panel border border-line bg-surface-raised shadow-overlay"
        >
          {problem ? (
            <p role="alert" className="px-2 py-2 text-error">
              {problem}
            </p>
          ) : loading && options.length === 0 ? (
            <p className="px-2 py-2 text-secondary">Searching…</p>
          ) : options.length === 0 ? (
            <p className="px-2 py-2 text-secondary">
              {query.trim() ? `Nothing matches “${query.trim()}”.` : 'No records yet.'}
            </p>
          ) : (
            options.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
                className={cn(
                  'flex w-full min-w-0 flex-col items-start px-2 py-1.5 text-left',
                  index === active && 'bg-fill',
                )}
              >
                <span className="w-full truncate">{option.label}</span>
                {option.detail ? (
                  <span className="w-full truncate text-small text-secondary">{option.detail}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
