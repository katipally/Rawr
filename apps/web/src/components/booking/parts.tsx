'use client'

import type { FormField } from '@rawr/db'
import { Fragment, useEffect, useRef, useState } from 'react'
import { BOOKING_COPY, hourIn, slotBandOf } from '~/lib/edge-copy.ts'
import {
  addDays,
  formatDayLong,
  formatMonth,
  formatTime,
  offsetLabel,
} from './time.ts'

/** The pieces the booking widget and the reschedule widget both draw.
 *
 *  Moving a meeting asks exactly the question booking one asks: which day, then
 *  which time, in whose timezone. Two implementations of that would drift the first
 *  time either was touched, so there is one, and each flow supplies its own data and
 *  its own answer to what happens when a time is picked. */

export const TimezonePicker = ({
  timezone,
  zones,
  at,
  open,
  onToggle,
  onPick,
}: {
  timezone: string
  zones: string[]
  at: Date
  open: boolean
  onToggle: () => void
  onPick: (zone: string) => void
}) => {
  const [filter, setFilter] = useState('')
  const wrap = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const away = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) onToggle()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onToggle()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open, onToggle])

  // Capped rather than virtualised: a browser knows about four hundred zones, and
  // nobody scrolls past the first screen without typing.
  const matches = zones
    .filter((zone) => zone.toLowerCase().includes(filter.trim().toLowerCase()))
    .slice(0, 60)

  return (
    <div className="rawr-b-tzwrap" ref={wrap}>
      <button
        type="button"
        className="rawr-b-tz"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={onToggle}
      >
        <Icon name="globe" />
        <span>{timezone}</span>
        <em>{offsetLabel(timezone, at)}</em>
      </button>

      {open ? (
        <div className="rawr-b-tzpop">
          <input
            ref={search}
            type="text"
            value={filter}
            placeholder="Search timezones"
            aria-label="Search timezones"
            onChange={(event) => setFilter(event.target.value)}
          />
          <ul className="rawr-b-tzlist" aria-label="Timezone">
            {matches.length === 0 ? (
              <li className="rawr-b-tzempty">No timezone matches that.</li>
            ) : (
              matches.map((zone) => (
                <li key={zone}>
                  <button
                    type="button"
                    aria-pressed={zone === timezone}
                    onClick={() => onPick(zone)}
                  >
                    <span>{zone}</span>
                    <em>{offsetLabel(zone, at)}</em>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

export const Calendar = ({
  monthKey,
  cells,
  byDay,
  weekdays,
  selected,
  today,
  locale,
  loading,
  onMonth,
  onDay,
}: {
  monthKey: string
  cells: (string | null)[]
  byDay: Map<string, Date[]>
  weekdays: string[]
  selected: string | null
  today: string
  locale: string
  loading: boolean
  onMonth: (by: number) => void
  onDay: (day: string) => void
}) => {
  const grid = useRef<HTMLDivElement>(null)
  const label = formatMonth(monthKey, locale)

  /** Which cell tab lands on. One tab stop for the whole month, then arrows: a
   *  grid where every day is a tab stop takes thirty presses to leave. */
  const roving =
    selected && selected.startsWith(monthKey)
      ? selected
      : (cells.find((cell) => cell && (byDay.get(cell)?.length ?? 0) > 0) ??
        cells.find(Boolean) ??
        `${monthKey}-01`)

  const move = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const from = (event.target as HTMLElement).dataset.day
    if (!from) return
    const by =
      event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowDown'
            ? 7
            : event.key === 'ArrowUp'
              ? -7
              : null
    if (by === null) {
      if (event.key === 'PageDown') onMonth(1)
      else if (event.key === 'PageUp') onMonth(-1)
      else return
      event.preventDefault()
      return
    }
    event.preventDefault()
    const target = addDays(from, by)
    if (!target.startsWith(monthKey)) {
      onMonth(by > 0 ? 1 : -1)
      return
    }
    grid.current?.querySelector<HTMLElement>(`[data-day="${target}"]`)?.focus()
  }

  return (
    <div>
      <div className="rawr-b-monthbar">
        <span className="rawr-b-month" id={`rawr-b-month-${monthKey}`}>
          {label}
        </span>
        <span className="rawr-b-nav">
          <button
            type="button"
            className="rawr-b-navb"
            aria-label="Earlier month"
            onClick={() => onMonth(-1)}
          >
            <Icon name="left" />
          </button>
          <button
            type="button"
            className="rawr-b-navb"
            aria-label="Later month"
            onClick={() => onMonth(1)}
          >
            <Icon name="right" />
          </button>
        </span>
      </div>

      <div className="rawr-b-cal">
        <div className="rawr-b-dow" aria-hidden="true">
          {weekdays.map((name) => (
            <span key={name}>{name.slice(0, 2)}</span>
          ))}
        </div>
        {/* Not role="grid": that promises rows of gridcells, and this is seven CSS
            columns of buttons. A grid with no rows announces as an empty grid. */}
        {/* biome-ignore lint/a11y/useSemanticElements: not a form control set and
            not a data table either. It is seven columns of day buttons with a
            name, which is exactly what role="group" describes. */}
        <div
          ref={grid}
          className="rawr-b-grid"
          role="group"
          aria-labelledby={`rawr-b-month-${monthKey}`}
          {...(loading ? { 'data-loading': '' } : {})}
          onKeyDown={move}
        >
          {cells.map((cell, index) =>
            cell === null ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: leading blanks have
              // no identity of their own; the index is the only thing they are.
              <span key={`pad-${index}`} className="rawr-b-day" />
            ) : (
              <Day
                key={cell}
                day={cell}
                count={byDay.get(cell)?.length ?? 0}
                selected={cell === selected}
                today={cell === today}
                tabbable={cell === roving}
                locale={locale}
                onPick={onDay}
              />
            ),
          )}
        </div>
        <p className="rawr-b-legend">
          <span>
            <span className="rawr-b-dot" />
            Times open
          </span>
          <span>
            <i />
            Today
          </span>
        </p>
      </div>
    </div>
  )
}

const Day = ({
  day,
  count,
  selected,
  today,
  tabbable,
  locale,
  onPick,
}: {
  day: string
  count: number
  selected: boolean
  today: boolean
  tabbable: boolean
  locale: string
  onPick: (day: string) => void
}) => {
  const open = count > 0
  const number = String(Number(day.slice(8)))
  return (
    <button
      type="button"
      className="rawr-b-day"
      data-day={day}
      data-open={open ? '1' : '0'}
      {...(today ? { 'data-today': '1' } : {})}
      aria-pressed={selected}
      aria-disabled={!open}
      tabIndex={tabbable ? 0 : -1}
      aria-label={`${formatDayLong(day, locale)}, ${
        open ? (count === 1 ? '1 time open' : `${count} times open`) : 'nothing open'
      }`}
      onClick={open ? () => onPick(day) : undefined}
    >
      <span aria-hidden="true">{number}</span>
      <span className="rawr-b-dot" {...(open ? {} : { 'data-empty': '' })} aria-hidden="true" />
    </button>
  )
}

export const Times = ({
  day,
  slots,
  timezone,
  locale,
  hour12,
  loading,
  duration,
  onHour12,
  onBack,
  onPick,
}: {
  day: string
  slots: Date[]
  timezone: string
  locale: string
  hour12: boolean
  loading: boolean
  duration: number
  onHour12: (value: boolean) => void
  onBack: () => void
  onPick: (iso: string) => void
}) => {
  // Named runs rather than one column of forty buttons. A band with nothing in it
  // is not drawn, so a nine-to-five day shows two.
  const bands = new Map<string, Date[]>()
  for (const at of slots) {
    const band = slotBandOf(hourIn(at, timezone))
    const list = bands.get(band)
    if (list) list.push(at)
    else bands.set(band, [at])
  }

  return (
    <div
      className="rawr-b-fade"
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}
    >
      <div className="rawr-b-rhead">
        <button type="button" className="rawr-b-back" data-narrow onClick={onBack}>
          <Icon name="left" />
          Calendar
        </button>
        <h2>{formatDayLong(day, locale)}</h2>
        {/* biome-ignore lint/a11y/useSemanticElements: two toggle buttons that
            share a name, not a set of form controls to submit. */}
        <span className="rawr-b-seg" role="group" aria-label="Time format">
          <button type="button" aria-pressed={hour12} onClick={() => onHour12(true)}>
            12h
          </button>
          <button type="button" aria-pressed={!hour12} onClick={() => onHour12(false)}>
            24h
          </button>
        </span>
      </div>

      {loading ? (
        <div className="rawr-b-skel" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      ) : slots.length === 0 ? (
        <p className="rawr-b-blank">{BOOKING_COPY.nothingOnDay}</p>
      ) : (
        <>
          <div className="rawr-b-times rawr-b-stagger">
            {[...bands].map(([band, list]) => (
              <Fragment key={band}>
                <p className="rawr-b-band">
                  <span className="rawr-b-bandname">{band}</span>
                </p>
                {list.map((at) => {
                  const iso = at.toISOString()
                  return (
                    <button
                      key={iso}
                      type="button"
                      className="rawr-b-slot"
                      onClick={() => onPick(iso)}
                    >
                      <span>{formatTime(at, timezone, locale, hour12)}</span>
                      <em>Select</em>
                    </button>
                  )
                })}
              </Fragment>
            ))}
          </div>
          <p className="rawr-b-hint" style={{ marginBlockStart: '0.6rem' }}>
            {slots.length === 1 ? '1 time' : `${slots.length} times`} · {duration} minutes each
          </p>
        </>
      )}
    </div>
  )
}

export const Question = ({
  field,
  error,
  initial,
}: {
  field: FormField
  error?: string | undefined
  initial?: string | undefined
}) => {
  const id = `rawr-q-${field.key}`
  const common = {
    id,
    name: field.key,
    required: field.required,
    defaultValue: initial,
    ...(error ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-error` } : {}),
  }

  return (
    <div className="rawr-b-field">
      <label htmlFor={id}>
        {field.label}
        {field.required ? ' *' : ''}
      </label>

      {field.type === 'long_text' ? (
        <textarea {...common} placeholder={field.placeholder} />
      ) : field.type === 'select' ? (
        <select {...common} defaultValue={initial ?? ''}>
          <option value="">Choose one…</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'multi_select' ? (
        <select {...common} multiple defaultValue={undefined}>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'boolean' ? (
        <input {...common} type="checkbox" value="true" defaultChecked={initial === 'true'} defaultValue={undefined} />
      ) : (
        <input
          {...common}
          type={
            field.type === 'email'
              ? 'email'
              : field.type === 'phone'
                ? 'tel'
                : field.type === 'url'
                  ? 'url'
                  : field.type === 'number'
                    ? 'number'
                    : field.type === 'date'
                      ? 'date'
                      : 'text'
          }
          placeholder={field.placeholder}
        />
      )}

      {error ? (
        <p id={`${id}-error`} role="alert" className="rawr-b-err">
          <Icon name="small" />
          {error}
        </p>
      ) : field.help ? (
        <p className="rawr-b-hint">{field.help}</p>
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------------- icons

const PATHS: Record<string, string> = {
  left: 'M10 3 5 8l5 5',
  right: 'M6 3l5 5-5 5',
  clock: 'M8 4.6V8l2.4 1.6',
  small: 'M8 5v3.4M8 11h.01',
  warn: 'M8 2.8 1.8 13.2h12.4L8 2.8ZM8 6.6v3M8 11.4h.01',
  place: 'M8 14s5-4.2 5-7.7A5 5 0 0 0 3 6.3C3 9.8 8 14 8 14Z',
  globe: 'M2 8h12M8 2c1.9 2.1 1.9 9.9 0 12M8 2C6.1 4.1 6.1 11.9 8 14',
}

export const Icon = ({ name }: { name: keyof typeof PATHS | string }) => (
  <svg className="rawr-b-icn" viewBox="0 0 16 16" aria-hidden="true">
    {name === 'clock' || name === 'small' || name === 'globe' ? (
      <circle cx="8" cy="8" r={name === 'small' ? 6.2 : 6} />
    ) : null}
    {name === 'place' ? <circle cx="8" cy="6.3" r="1.8" /> : null}
    <path d={PATHS[name] ?? ''} />
  </svg>
)
