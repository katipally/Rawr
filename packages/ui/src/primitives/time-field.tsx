'use client'

import { type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TextInput } from './field.tsx'
import { Popover } from './popover.tsx'
import { clockLabel, committedOnBlur, parseClock, suggestedTimes } from './time-field.ts'

/** Every quarter hour is offered: most meetings and send windows start on one. */
const STEP_MINUTES = 15

export type TimeFieldProps = {
  id: string
  /** 'HH:MM' in 24 hours, or '' for none. */
  value: string
  onChange: (value: string) => void
  /** The viewer's locale, which decides whether the list reads 9:30 AM or 09:30. */
  locale: string
  disabled?: boolean | undefined
  className?: string | undefined
  'aria-label'?: string | undefined
  'aria-describedby'?: string | undefined
  'aria-invalid'?: boolean | undefined
}

const TIMES = suggestedTimes(STEP_MINUTES)

/** Spaces and case dropped, so "9:30 am" and "9:30AM" are the same search. */
const squash = (text: string): string => text.toLowerCase().replaceAll(/\s+/g, '')

/** A time you can type or pick. Typing reads what you mean and the list narrows
 *  under it; the arrow keys walk the list and Enter takes the highlight. Leaving
 *  the field with text that is not a time puts back the time it had. */
export const TimeField = ({
  id,
  value,
  onChange,
  locale,
  disabled = false,
  className,
  'aria-label': ariaLabel,
  ...described
}: TimeFieldProps) => {
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  /** What is typed, or null while the field shows the stored time. */
  const [typed, setTyped] = useState<string | null>(null)
  const [active, setActive] = useState(-1)
  /** Whether the arrow keys moved the highlight since the list last opened or typed. */
  const [touched, setTouched] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const highlighted = useRef<HTMLDivElement>(null)

  const options = useMemo(() => TIMES.map((time) => ({ value: time, label: clockLabel(time, locale) })), [locale])
  const shown = useMemo(() => {
    if (!typed) return options
    const query = squash(typed)
    return options.filter((option) => squash(option.label).includes(query) || option.value.includes(query))
  }, [options, typed])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the highlight follows the list it is in
  useLayoutEffect(() => {
    if (open) highlighted.current?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const openList = () => {
    setOpen(true)
    setActive(options.findIndex((option) => option.value === value))
  }

  const close = () => {
    setOpen(false)
    setTouched(false)
  }

  /** null keeps the stored time; '' clears it; text that is not a time keeps it. */
  const commit = (text: string | null) => {
    setTyped(null)
    close()
    if (text === null) return
    const next = text.trim() === '' ? '' : parseClock(text)
    if (next !== null && next !== value) onChange(next)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setTouched(true)
      if (!open) {
        openList()
        return
      }
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((at) => (shown.length === 0 ? -1 : (at + step + shown.length) % shown.length))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const pick = open ? shown[active]?.value : undefined
      const typedIsTime = typed !== null && (typed.trim() === '' || parseClock(typed) !== null)
      commit(typedIsTime ? typed : (pick ?? typed))
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      commit(null)
    }
  }

  return (
    <div ref={box}>
      <TextInput
        id={id}
        className={className}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${id}-option-${shown[active].value}` : undefined}
        aria-label={ariaLabel}
        autoComplete="off"
        disabled={disabled}
        value={typed ?? clockLabel(value, locale)}
        onChange={(event) => {
          setTyped(event.target.value)
          setOpen(true)
          setActive(0)
          setTouched(false)
        }}
        onClick={openList}
        onBlur={() => commit(committedOnBlur(typed, shown[active]?.value, touched, value))}
        onKeyDown={onKeyDown}
        {...described}
      />
      <Popover
        open={open && !disabled}
        onClose={close}
        anchorRef={box}
        autoFocus={false}
        side="bottom"
        align="start"
        label={ariaLabel ?? 'Times'}
        className="min-w-32 py-1"
      >
        <div id={listId} role="listbox" aria-label={ariaLabel ?? 'Times'}>
          {shown.length === 0 ? (
            <p className="px-3 py-2 text-secondary">Type a time such as 9:30 am or 14:30.</p>
          ) : null}
          {shown.map((option, index) => (
            <div
              key={option.value}
              ref={index === active ? highlighted : null}
              id={`${id}-option-${option.value}`}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              // Mouse down, not click: the field must not blur before the pick lands.
              onMouseDown={(event) => {
                event.preventDefault()
                commit(option.value)
              }}
              onMouseEnter={() => setActive(index)}
              className={index === active ? 'cursor-pointer bg-fill-hover px-3 py-1.5' : 'cursor-pointer px-3 py-1.5'}
            >
              {option.label}
            </div>
          ))}
        </div>
      </Popover>
    </div>
  )
}
