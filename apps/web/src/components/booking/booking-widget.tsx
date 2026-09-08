'use client'

import type { FormField } from '@rawr/db'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BOOKING_COPY,
  BOOKING_LOCATIONS,
  bookingHosts,
  bookingNextAvailable,
  countdown,
} from '~/lib/edge-copy.ts'
import { Calendar, Icon, Question, Times, TimezonePicker } from './parts.tsx'
import {
  dayKeyIn,
  detectTimezone,
  formatDayLong,
  formatDayShort,
  formatMonth,
  formatTime,
  knownTimezones,
  monthCells,
  monthKeyOf,
  offsetLabel,
  shiftMonth,
  weekInfo,
} from './time.ts'

/** The public booking widget. F2 §4 and §7.
 *
 *  One implementation for two surfaces: the hosted page mounts it directly, and
 *  the embed loads that same page in a frame. There is no second renderer to keep
 *  in step, which is what the hand-written embed script used to cost.
 *
 *  The server resolves the first month so the first paint is a calendar rather than
 *  a spinner. Everything after that is this component talking to the three public
 *  endpoints it already had: /slots to read a month, /hold to reserve a time while
 *  the questions are filled in, /confirm to book. */

export type BookingWidgetPage = {
  account: string
  slug: string
  name: string
  organisation: string
  hostNames: string[]
  durationMinutes: number
  location: string
  fields: FormField[]
  confirmationCopy: string | null
  redirectUrl: string | null
}

export type BookingMonth = {
  month: string
  timezone: string
  slots: { startsAt: string; capacity: number }[]
  unavailable: string | null
  nextAvailable: string | null
}

type Step = 'day' | 'time' | 'form'

type Booked = {
  startsAt: string
  endsAt: string
  hostName: string
  conferenceUrl: string | null
  calendarUrl: string
  rescheduleUrl: string
  cancelUrl: string
  warnings: string[]
  message: string | null
}

const HOLD_MS = 5 * 60 * 1000

export const BookingWidget = ({
  page,
  initial,
  baseUrl = '',
}: {
  page: BookingWidgetPage
  initial: BookingMonth
  baseUrl?: string
}) => {
  const endpoint = `${baseUrl}/b/${encodeURIComponent(page.account)}/${encodeURIComponent(page.slug)}`

  const [locale, setLocale] = useState('en-US')
  const [timezone, setTimezone] = useState(initial.timezone)
  const [hour12, setHour12] = useState(true)
  const [monthKey, setMonthKey] = useState(initial.month)
  const [month, setMonth] = useState<BookingMonth>(initial)
  const [loading, setLoading] = useState(false)
  const [day, setDay] = useState<string | null>(null)
  const [slot, setSlot] = useState<string | null>(null)
  const [step, setStep] = useState<Step>('day')
  const [hold, setHold] = useState<{ token: string; expiresAt: number } | null>(null)
  const [remaining, setRemaining] = useState(HOLD_MS)
  const [notice, setNotice] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [booked, setBooked] = useState<Booked | null>(null)
  const [tzOpen, setTzOpen] = useState(false)

  const [announcement, setAnnouncement] = useState('')
  const say = useCallback((message: string) => setAnnouncement(message), [])

  const now = useRef(new Date()).current

  // The visitor's own week and clock, which the server cannot know. Reading them
  // after mount rather than during render keeps the server and client markup
  // identical, so React never has to throw the first paint away.
  useEffect(() => {
    const tag = navigator.languages?.[0] ?? navigator.language ?? 'en-US'
    setLocale(tag)
    // Whichever clock the visitor's own locale uses, not ours.
    setHour12(new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hour12 === true)
    const detected = detectTimezone()
    if (detected !== initial.timezone) setTimezone(detected)
  }, [initial.timezone])

  const week = useMemo(() => weekInfo(locale), [locale])
  const zones = useMemo(() => knownTimezones(timezone), [timezone])

  // ------------------------------------------------------------- reading a month
  const stale = month.month !== monthKey || month.timezone !== timezone
  const requestId = useRef(0)

  const load = useCallback(
    async (targetMonth: string, targetZone: string) => {
      const id = ++requestId.current
      setLoading(true)
      try {
        const response = await fetch(
          `${endpoint}/slots?month=${encodeURIComponent(targetMonth)}&tz=${encodeURIComponent(targetZone)}`,
          { headers: { accept: 'application/json' } },
        )
        const body = (await response.json()) as Partial<BookingMonth> & { error?: string }
        if (id !== requestId.current) return
        if (!response.ok) {
          setMonth({
            month: targetMonth,
            timezone: targetZone,
            slots: [],
            unavailable: body.error ?? BOOKING_COPY.failed,
            nextAvailable: null,
          })
          return
        }
        setMonth({
          month: body.month ?? targetMonth,
          timezone: body.timezone ?? targetZone,
          slots: body.slots ?? [],
          unavailable: body.unavailable ?? null,
          nextAvailable: body.nextAvailable ?? null,
        })
      } catch {
        if (id !== requestId.current) return
        setMonth({
          month: targetMonth,
          timezone: targetZone,
          slots: [],
          unavailable: navigator.onLine ? BOOKING_COPY.failed : BOOKING_COPY.offline,
          nextAvailable: null,
        })
      } finally {
        if (id === requestId.current) setLoading(false)
      }
    },
    [endpoint],
  )

  useEffect(() => {
    if (stale) void load(monthKey, timezone)
  }, [stale, monthKey, timezone, load])

  // ------------------------------------------------------------------ grouping
  /** Grouped by the visitor's own calendar date, because that is the date they are
   *  clicking on. Recomputed when the zone changes, which is what makes a shared
   *  link read correctly in Jakarta and in Chicago. */
  const byDay = useMemo(() => {
    const map = new Map<string, Date[]>()
    if (month.timezone !== timezone) return map
    for (const entry of month.slots) {
      const at = new Date(entry.startsAt)
      const key = dayKeyIn(at, timezone)
      const list = map.get(key)
      if (list) list.push(at)
      else map.set(key, [at])
    }
    return map
  }, [month, timezone])

  const daySlots = day ? (byDay.get(day) ?? []) : []
  const todayKey = dayKeyIn(now, timezone)
  const cells = useMemo(() => monthCells(monthKey, week.firstDay), [monthKey, week.firstDay])
  const monthIsEmpty = byDay.size === 0

  const firstOpen = useMemo(() => {
    for (const cell of cells) if (cell && (byDay.get(cell)?.length ?? 0) > 0) return cell
    return null
  }, [cells, byDay])

  // -------------------------------------------------------------------- holding
  const releaseHold = useCallback(
    (token: string) => {
      // Best effort: a hold that outlives the person who placed it expires on its
      // own five minutes later, so a failed release costs a slot nothing.
      void fetch(`${endpoint}/hold?token=${encodeURIComponent(token)}`, {
        method: 'DELETE',
        keepalive: true,
      }).catch(() => undefined)
    },
    [endpoint],
  )

  const chooseSlot = useCallback(
    (iso: string) => {
      if (hold) releaseHold(hold.token)
      setSlot(iso)
      setStep('form')
      setErrors({})
      setNotice(null)
      setHold(null)
      setRemaining(HOLD_MS)
      void fetch(`${endpoint}/hold`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ slot: iso }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { token?: string; expiresAt?: string } | null) => {
          if (!body?.token || !body.expiresAt) return
          setHold({ token: body.token, expiresAt: new Date(body.expiresAt).getTime() })
        })
        .catch(() => undefined)
    },
    [endpoint, hold, releaseHold],
  )

  useEffect(() => {
    if (!hold) return
    const tick = () => {
      const left = hold.expiresAt - Date.now()
      setRemaining(left)
      if (left <= 0) {
        setHold(null)
        setSlot(null)
        setStep('time')
        setNotice(BOOKING_COPY.holdExpired)
        void load(monthKey, timezone)
      }
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [hold, load, monthKey, timezone])

  // ------------------------------------------------------------------- actions
  const goMonth = (by: number) => {
    const next = shiftMonth(monthKey, by)
    setMonthKey(next)
    setDay(null)
    setSlot(null)
    setStep('day')
    setNotice(null)
  }

  const goDay = (target: string) => {
    setMonthKey(monthKeyOf(target))
    setDay(target)
    setSlot(null)
    setStep('time')
    setNotice(null)
    say(`${byDay.get(target)?.length ?? 0} times open on ${formatDayLong(target, locale)}.`)
  }

  const setZone = (next: string) => {
    setTimezone(next)
    setTzOpen(false)
    setSlot(null)
    setStep(day ? 'time' : 'day')
    say(`Times now shown in ${next}, ${offsetLabel(next, now)}.`)
  }

  const confirm = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!slot) return
    const form = new FormData(event.currentTarget)
    const body: Record<string, unknown> = {
      slot,
      timezone,
      hold: hold?.token ?? null,
      pagePath: typeof location === 'undefined' ? null : location.pathname,
    }
    const next: Record<string, string> = {}
    for (const field of page.fields) {
      const all = form.getAll(field.key).map(String)
      next[field.key] = all[0] ?? ''
      body[field.key] = field.type === 'multi_select' ? all : (all[0] ?? '')
    }
    setAnswers(next)
    setBusy(true)
    setErrors({})
    setNotice(null)

    try {
      const response = await fetch(`${endpoint}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = (await response.json()) as Booked & {
        error?: string
        kind?: string
        fields?: { key: string; message: string }[]
        redirectUrl?: string | null
      }

      if (!response.ok) {
        if (result.fields?.length) {
          const map: Record<string, string> = {}
          for (const problem of result.fields) map[problem.key] = problem.message
          setErrors(map)
          setNotice(BOOKING_COPY.invalid)
          return
        }
        // A slot that has gone is not a failure the visitor caused, so the list
        // they land on is refreshed rather than left showing a time nobody can have.
        if (result.kind === 'slot-gone') {
          setSlot(null)
          setHold(null)
          setStep('time')
          setNotice(BOOKING_COPY.slotGone)
          void load(monthKey, timezone)
          return
        }
        setNotice(result.error ?? BOOKING_COPY.failed)
        return
      }

      if (result.redirectUrl) {
        location.href = result.redirectUrl
        return
      }
      setHold(null)
      setBooked(result)
      say(`Booked. ${formatDayLong(dayKeyIn(new Date(result.startsAt), timezone), locale)}.`)
    } catch {
      setNotice(navigator.onLine ? BOOKING_COPY.failed : BOOKING_COPY.offline)
    } finally {
      setBusy(false)
    }
  }

  // --------------------------------------------------------------------- render
  return (
    <div className="rawr-b" data-step={step}>
      <p className="rawr-b-sr" aria-live="polite">
        {announcement}
      </p>

      <Head
        page={page}
        timezone={timezone}
        zones={zones}
        at={now}
        open={tzOpen}
        onToggle={() => setTzOpen((was) => !was)}
        onPick={setZone}
      />

      <div className="rawr-b-body">
        {booked ? (
          <Done
            booked={booked}
            page={page}
            timezone={timezone}
            locale={locale}
            hour12={hour12}
            onAgain={() => {
              setBooked(null)
              setDay(null)
              setSlot(null)
              setAnswers({})
              setStep('day')
            }}
          />
        ) : (
          <>
            {notice ? (
              <p className="rawr-b-note" data-bad role="alert">
                <Icon name="warn" />
                {notice}
              </p>
            ) : null}
            {month.unavailable ? (
              <p className="rawr-b-note" data-bad role="alert">
                <Icon name="warn" />
                {month.unavailable}
              </p>
            ) : null}

            <div className="rawr-b-split">
              <div className="rawr-b-pane" data-side="left">
                <Calendar
                  monthKey={monthKey}
                  cells={cells}
                  byDay={byDay}
                  weekdays={week.weekdays}
                  selected={day}
                  today={todayKey}
                  locale={locale}
                  loading={loading}
                  onMonth={goMonth}
                  onDay={goDay}
                />
              </div>

              <div className="rawr-b-pane" data-side="right">
                {day === null ? (
                  <Blank
                    monthKey={monthKey}
                    locale={locale}
                    empty={monthIsEmpty && !month.unavailable}
                    nextAvailable={month.nextAvailable}
                    timezone={timezone}
                    firstOpen={firstOpen}
                    onGo={goDay}
                  />
                ) : slot === null ? (
                  <Times
                    day={day}
                    slots={daySlots}
                    timezone={timezone}
                    locale={locale}
                    hour12={hour12}
                    loading={loading}
                    duration={page.durationMinutes}
                    onHour12={setHour12}
                    onBack={() => setStep('day')}
                    onPick={chooseSlot}
                  />
                ) : (
                  <Details
                    page={page}
                    slot={slot}
                    timezone={timezone}
                    locale={locale}
                    hour12={hour12}
                    hold={hold}
                    remaining={remaining}
                    errors={errors}
                    answers={answers}
                    busy={busy}
                    onBack={() => {
                      if (hold) releaseHold(hold.token)
                      setHold(null)
                      setSlot(null)
                      setStep('time')
                    }}
                    onSubmit={confirm}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>

      <p className="rawr-b-foot">
        <span>
          {timezone} {offsetLabel(timezone, now)}
        </span>
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------- header

const Head = ({
  page,
  timezone,
  zones,
  at,
  open,
  onToggle,
  onPick,
}: {
  page: BookingWidgetPage
  timezone: string
  zones: string[]
  at: Date
  open: boolean
  onToggle: () => void
  onPick: (zone: string) => void
}) => {
  const initials = page.hostNames
    .slice(0, 3)
    .map((name) =>
      name
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0] ?? '')
        .join('')
        .toUpperCase(),
    )

  return (
    <div className="rawr-b-head">
      <div className="rawr-b-id">
        <span className="rawr-b-org">{page.organisation}</span>
        <h1 className="rawr-b-title">{page.name}</h1>
        <p className="rawr-b-meta">
          {page.hostNames.length > 0 ? (
            <span>
              <span className="rawr-b-hosts" aria-hidden="true">
                {initials.map((mark, index) => (
                  <span key={`${mark}-${index}`}>{mark}</span>
                ))}
              </span>
              {bookingHosts(page.hostNames)}
            </span>
          ) : null}
          {page.hostNames.length > 0 ? <span className="rawr-b-sep" aria-hidden="true" /> : null}
          <span>
            <Icon name="clock" />
            {page.durationMinutes} minutes
          </span>
          <span className="rawr-b-sep" aria-hidden="true" />
          <span>
            <Icon name="place" />
            {BOOKING_LOCATIONS[page.location] ?? page.location}
          </span>
        </p>
      </div>

      <TimezonePicker
        timezone={timezone}
        zones={zones}
        at={at}
        open={open}
        onToggle={onToggle}
        onPick={onPick}
      />
    </div>
  )
}

// -------------------------------------------------------------------- calendar

// ----------------------------------------------------------------- right pane

const Blank = ({
  monthKey,
  locale,
  empty,
  nextAvailable,
  timezone,
  firstOpen,
  onGo,
}: {
  monthKey: string
  locale: string
  empty: boolean
  nextAvailable: string | null
  timezone: string
  firstOpen: string | null
  onGo: (day: string) => void
}) => {
  const target = firstOpen ?? (nextAvailable ? dayKeyIn(new Date(nextAvailable), timezone) : null)

  return (
    <div className="rawr-b-fade" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div className="rawr-b-rhead">
        <h2>{empty ? `Nothing in ${formatMonth(monthKey, locale)}` : 'Pick a day'}</h2>
      </div>
      <div className="rawr-b-blank">
        {empty ? (
          target ? (
            <p>{bookingNextAvailable(formatDayLong(target, locale))}</p>
          ) : (
            <p>{BOOKING_COPY.nothingAtAll}</p>
          )
        ) : (
          <>
            <b>Days with a dot have times</b>
            <p>{BOOKING_COPY.pickDay}</p>
          </>
        )}
        {target ? (
          <button type="button" className="rawr-b-ghost" onClick={() => onGo(target)}>
            Go to {formatDayShort(target, locale)}
          </button>
        ) : null}
      </div>
    </div>
  )
}

const Details = ({
  page,
  slot,
  timezone,
  locale,
  hour12,
  hold,
  remaining,
  errors,
  answers,
  busy,
  onBack,
  onSubmit,
}: {
  page: BookingWidgetPage
  slot: string
  timezone: string
  locale: string
  hour12: boolean
  hold: { token: string; expiresAt: number } | null
  remaining: number
  errors: Record<string, string>
  answers: Record<string, string>
  busy: boolean
  onBack: () => void
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void
}) => {
  const start = new Date(slot)
  const end = new Date(start.getTime() + page.durationMinutes * 60_000)
  const urgent = remaining <= 60_000

  return (
    <div className="rawr-b-fade" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="rawr-b-rhead">
        <button type="button" className="rawr-b-back" onClick={onBack}>
          <Icon name="left" />
          Times
        </button>
        <h2 style={{ flex: 1 }}>Your details</h2>
      </div>

      <p className="rawr-b-summary">
        <span>
          <b>
            {formatTime(start, timezone, locale, hour12)} – {formatTime(end, timezone, locale, hour12)}
          </b>
          <span>{formatDayLong(dayKeyIn(start, timezone), locale)}</span>
        </span>
      </p>

      {hold ? (
        <p className="rawr-b-hold" {...(urgent ? { 'data-urgent': '' } : {})}>
          Held for you
          <b>{countdown(remaining)}</b>
          <i aria-hidden="true">
            <i style={{ scale: `${Math.max(0, remaining) / HOLD_MS} 1` }} />
          </i>
        </p>
      ) : null}

      <form className="rawr-b-form" onSubmit={onSubmit} noValidate>
        {page.fields.map((field) => (
          <Question
            key={field.key}
            field={field}
            error={errors[field.key]}
            initial={answers[field.key]}
          />
        ))}
        <button type="submit" className="rawr-b-cta" {...(busy ? { 'data-busy': '' } : {})}>
          {busy ? <span className="rawr-b-spin" aria-hidden="true" /> : null}
          {busy ? BOOKING_COPY.booking : `Confirm ${page.durationMinutes} minutes`}
        </button>
        <p className="rawr-b-hint">
          You will get a calendar invitation with the joining details and a link to move or cancel.
        </p>
      </form>
    </div>
  )
}

// ------------------------------------------------------------------- confirmed

const Done = ({
  booked,
  page,
  timezone,
  locale,
  hour12,
  onAgain,
}: {
  booked: Booked
  page: BookingWidgetPage
  timezone: string
  locale: string
  hour12: boolean
  onAgain: () => void
}) => {
  const start = new Date(booked.startsAt)
  const end = new Date(booked.endsAt)

  return (
    <div className="rawr-b-done">
      <span className="rawr-b-tick" aria-hidden="true">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 12.5 9.5 18 20 6.5" />
        </svg>
      </span>
      <h2>{BOOKING_COPY.booked}</h2>

      <div className="rawr-b-card">
        <div>
          <i>When</i>
          <b>
            {formatDayLong(dayKeyIn(start, timezone), locale)}
            <br />
            {formatTime(start, timezone, locale, hour12)} –{' '}
            {formatTime(end, timezone, locale, hour12)}
          </b>
        </div>
        <div>
          <i>Zone</i>
          <b>{timezone}</b>
        </div>
        <div>
          <i>With</i>
          <b>{booked.hostName}</b>
        </div>
        <div>
          <i>Where</i>
          <b>{BOOKING_LOCATIONS[page.location] ?? page.location}</b>
        </div>
      </div>

      <p className="rawr-b-hint" style={{ maxWidth: '36ch' }}>
        {booked.message ??
          page.confirmationCopy ??
          'A calendar invitation is on its way to your inbox, with the joining details and links to move or cancel the meeting.'}
      </p>

      {booked.warnings.length > 0 ? (
        <p className="rawr-b-note" data-warn>
          <Icon name="warn" />
          {booked.warnings[0]}
        </p>
      ) : null}

      <p className="rawr-b-actions">
        <a className="rawr-b-link" href={booked.calendarUrl}>
          {BOOKING_COPY.addToCalendar}
        </a>
        <a className="rawr-b-link" href={booked.rescheduleUrl}>
          {BOOKING_COPY.reschedule}
        </a>
        <a className="rawr-b-link" href={booked.cancelUrl}>
          {BOOKING_COPY.cancel}
        </a>
        <button type="button" className="rawr-b-link" onClick={onAgain}>
          Book another
        </button>
      </p>
    </div>
  )
}

