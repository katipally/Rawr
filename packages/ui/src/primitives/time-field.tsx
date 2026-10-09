'use client'

import { type KeyboardEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { TextInput } from './field.tsx'
import { Popover } from './popover.tsx'
import {
  clockLabel,
  closedField,
  narrow,
  stepTimeField,
  suggestedTimes,
  type TimeFieldEvent,
  type TimeFieldState,
} from './time-field.ts'

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
  const [field, setField] = useState<TimeFieldState>(closedField)
  const box = useRef<HTMLDivElement>(null)
  const highlighted = useRef<HTMLDivElement>(null)
  const lit = field.hover >= 0 ? field.hover : field.highlight

  const options = useMemo(() => TIMES.map((time) => ({ value: time, label: clockLabel(time, locale) })), [locale])
  const shown = useMemo(() => narrow(options, field.typed), [options, field.typed])

  // biome-ignore lint/correctness/useExhaustiveDependencies: the highlight follows the list it is in
  useLayoutEffect(() => {
    if (field.open) highlighted.current?.scrollIntoView({ block: 'nearest' })
  }, [field.open, lit])

  const dispatch = (event: TimeFieldEvent) => {
    const step = stepTimeField(field, event, value, options)
    setField(step.state)
    if (step.emit !== null) onChange(step.emit)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      dispatch({ type: 'arrow', step: event.key === 'ArrowDown' ? 1 : -1 })
    } else if (event.key === 'Enter') {
      event.preventDefault()
      dispatch({ type: 'settle' })
    } else if (event.key === 'Escape' && field.open) {
      event.preventDefault()
      // Stops the popover's own Escape listener, which would act on the field as it was before this reset.
      event.stopPropagation()
      dispatch({ type: 'escape' })
    }
  }

  return (
    <div ref={box}>
      <TextInput
        id={id}
        className={className}
        role="combobox"
        aria-expanded={field.open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={field.open && shown[field.highlight] ? `${id}-option-${shown[field.highlight]?.value}` : undefined}
        aria-label={ariaLabel}
        autoComplete="off"
        disabled={disabled}
        value={field.typed ?? clockLabel(value, locale)}
        onChange={(event) => dispatch({ type: 'text', text: event.target.value })}
        onClick={() => dispatch({ type: 'open' })}
        onBlur={() => dispatch({ type: 'settle' })}
        onKeyDown={onKeyDown}
        {...described}
      />
      <Popover
        open={field.open && !disabled}
        onClose={() => dispatch({ type: 'dismiss' })}
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
              ref={index === lit ? highlighted : null}
              id={`${id}-option-${option.value}`}
              role="option"
              tabIndex={-1}
              aria-selected={option.value === value}
              // Mouse down, not click: the field must not blur before the pick lands.
              onMouseDown={(event) => {
                event.preventDefault()
                dispatch({ type: 'pick', value: option.value })
              }}
              onMouseEnter={() => dispatch({ type: 'hoverEnter', index })}
              onMouseLeave={() => dispatch({ type: 'hoverLeave' })}
              className={index === lit ? 'cursor-pointer bg-fill-hover px-3 py-1.5' : 'cursor-pointer px-3 py-1.5'}
            >
              {option.label}
            </div>
          ))}
        </div>
      </Popover>
    </div>
  )
}
