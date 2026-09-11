'use client'

import { Check, ChevronDown, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../cn.ts'
import { filterOptions } from './combobox.ts'
import { Popover } from './popover.tsx'
import { Spinner } from './spinner.tsx'

export type ComboboxOption = {
  value: string
  label: string
  hint?: string | undefined
  keywords?: string[] | undefined
  disabled?: boolean | undefined
}

type Shared = {
  label: string
  options: ComboboxOption[]
  placeholder?: string | undefined
  /** Hands the typed query to the caller, for lists too large to send whole.
   *  When set, local filtering is skipped: the options prop is the answer. */
  onSearch?: ((query: string) => void) | undefined
  loading?: boolean | undefined
  disabled?: boolean | undefined
  /** Shown under the control, red when `invalid`. */
  error?: string | undefined
  hint?: string | undefined
  className?: string | undefined
  id?: string | undefined
}

export type ComboboxProps = Shared &
  (
    | { multiple?: false; value: string | null; onChange: (value: string | null) => void }
    | { multiple: true; value: string[]; onChange: (value: string[]) => void }
  )

/** A select you can type into. Used wherever a native select would need more
 *  than about a dozen options: owners, sequences, mailboxes, properties. */
export const Combobox = (props: ComboboxProps) => {
  const {
    label,
    options,
    placeholder = 'Search',
    onSearch,
    loading = false,
    disabled = false,
    error,
    hint,
    className,
  } = props
  const generated = useId()
  const id = props.id ?? generated
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const highlighted = useRef<HTMLDivElement>(null)

  const shown = onSearch ? options : filterOptions(options, query)
  const selected = props.multiple ? props.value : props.value === null ? [] : [props.value]
  const chosen = options.filter((option) => selected.includes(option.value))

  // Both are triggers rather than reads: a new query or a new list puts the
  // highlight back on the first row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => setActive(0), [query, options])

  // The input keeps the focus, so the browser scrolls nothing when the arrow keys
  // move the highlight: past the eighth owner in a list of two hundred the
  // selection was being moved somewhere the reader could not see. The highlight is
  // the trigger rather than something the effect reads: the ref it scrolls is
  // re-pointed by the render that moved it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useLayoutEffect(() => {
    if (open) highlighted.current?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const commit = (option: ComboboxOption) => {
    if (option.disabled) return
    if (props.multiple) {
      const has = props.value.includes(option.value)
      props.onChange(has ? props.value.filter((value) => value !== option.value) : [...props.value, option.value])
      setQuery('')
      return
    }
    props.onChange(option.value === props.value ? null : option.value)
    setQuery('')
    setOpen(false)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((at) => (shown.length === 0 ? 0 : (at + step + shown.length) % shown.length))
    } else if (event.key === 'Enter' && open) {
      const option = shown[active]
      if (option) {
        event.preventDefault()
        commit(option)
      }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
    } else if (event.key === 'Backspace' && query === '' && props.multiple && props.value.length > 0) {
      props.onChange(props.value.slice(0, -1))
    }
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={id} className="font-medium">
        {label}
      </label>
      <div
        ref={box}
        className={cn(
          'flex min-h-9 flex-wrap items-center gap-1 rounded-hs border bg-surface px-2 py-1',
          // The input inside carries no outline of its own, so the ring is drawn
          // on the box: a combobox reads as one control, and a 1px border going
          // teal is not a focus indicator anybody notices.
          'has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
          error ? 'border-error' : 'border-line focus-within:border-line-interactive',
          disabled && 'bg-disabled',
        )}
      >
        {props.multiple
          ? chosen.map((option) => (
              <span
                key={option.value}
                className="inline-flex max-w-full items-center gap-1 rounded-hs bg-fill px-1.5 py-0.5 text-small"
              >
                <span className="min-w-0 truncate">{option.label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${option.label}`}
                  disabled={disabled}
                  onClick={() => props.onChange(props.value.filter((value) => value !== option.value))}
                  className="shrink-0 text-secondary hover:text-error"
                >
                  <X aria-hidden="true" className="size-3" />
                </button>
              </span>
            ))
          : null}
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[active] ? `${id}-option-${shown[active]!.value}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-note` : undefined}
          disabled={disabled}
          value={open || props.multiple ? query : (chosen[0]?.label ?? '')}
          placeholder={props.multiple && chosen.length > 0 ? '' : placeholder}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
            onSearch?.(event.target.value)
          }}
          // Opened by a click, by typing, or by the down arrow -- never by focus
          // alone. Focus comes back to this input whenever the list closes, and a
          // list that reopens on focus can therefore never be closed.
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="min-w-24 flex-1 bg-transparent outline-none placeholder:text-secondary"
        />
        {loading ? <Spinner size="sm" label="Searching" /> : null}
        {!props.multiple && props.value !== null && !disabled ? (
          <button
            type="button"
            aria-label={`Clear ${label}`}
            onClick={() => {
              props.onChange(null)
              setQuery('')
              input.current?.focus()
            }}
            className="shrink-0 text-secondary hover:text-body"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={open ? `Close ${label}` : `Open ${label}`}
          disabled={disabled}
          onClick={() => {
            setOpen(!open)
            input.current?.focus()
          }}
          className="shrink-0 text-secondary hover:text-body"
        >
          <ChevronDown aria-hidden="true" className="size-4" />
        </button>
      </div>
      {error || hint ? (
        <p id={`${id}-note`} className={cn('text-small', error ? 'text-error' : 'text-secondary')}>
          {error ?? hint}
        </p>
      ) : null}

      <Popover
        open={open && !disabled}
        onClose={() => setOpen(false)}
        anchorRef={box}
        autoFocus={false}
        side="bottom"
        align="start"
        label={label}
        className="min-w-64 py-1"
      >
        {/* Divs rather than a list: these carry listbox and option roles, and a
            <li role="option"> is two contradictory meanings on one element. */}
        <div id={listId} role="listbox" aria-label={label} aria-multiselectable={props.multiple || undefined}>
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-secondary">
              {loading ? 'Searching…' : query ? `Nothing matches “${query}”.` : 'Nothing to choose from yet.'}
            </p>
          ) : null}
          {shown.map((option, index) => {
            const picked = selected.includes(option.value)
            return (
              // The input keeps the focus and drives the list through
              // aria-activedescendant, which is the listbox pattern: an option is
              // never itself a focus stop, so it is a list item and not a button.
              <div
                key={option.value}
                ref={index === active ? highlighted : null}
                id={`${id}-option-${option.value}`}
                role="option"
                tabIndex={-1}
                aria-selected={picked}
                aria-disabled={option.disabled || undefined}
                // Mouse down, not click: the input must not blur first.
                onMouseDown={(event) => {
                  event.preventDefault()
                  commit(option)
                }}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-left',
                  option.disabled && 'cursor-not-allowed text-secondary opacity-60',
                  index === active && !option.disabled && 'bg-fill-hover',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  {option.hint ? <span className="block truncate text-small text-secondary">{option.hint}</span> : null}
                </span>
                {picked ? <Check aria-hidden="true" className="size-4 shrink-0 text-link" /> : null}
              </div>
            )
          })}
        </div>
      </Popover>
    </div>
  )
}
