'use client'

import { useEffect, useMemo, useState } from 'react'
import { PendingButton } from '~/components/pending-button.tsx'
import { BOOKING_COPY } from '~/lib/edge-copy.ts'
import { Calendar, Icon, Times, TimezonePicker } from './parts.tsx'
import {
  dayKeyIn,
  formatDayLong,
  formatTime,
  knownTimezones,
  monthCells,
  monthKeyOf,
  offsetLabel,
  shiftMonth,
  weekInfo,
} from './time.ts'

/** Moving a meeting, asked the way booking one is asked.
 *
 *  Three weeks of half-hour slots is several hundred radio buttons on one page,
 *  which is what the form this replaces cost. The same calendar and the same time
 *  list answer it in two clicks.
 *
 *  Every open time in the horizon arrives at once, because the page had to read them
 *  all to know whether there were any. So this fetches nothing: changing month or
 *  timezone is regrouping instants that are already here. */

export const RescheduleWidget = ({
  slots,
  timezone: initialTimezone,
  durationMinutes,
  token,
  action,
  cancelHref,
}: {
  slots: string[]
  timezone: string
  durationMinutes: number
  token: string
  action: (data: FormData) => void | Promise<void>
  cancelHref: string
}) => {
  const [locale, setLocale] = useState('en-US')
  const [hour12, setHour12] = useState(true)
  const [timezone, setTimezone] = useState(initialTimezone)
  const [tzOpen, setTzOpen] = useState(false)
  const [day, setDay] = useState<string | null>(null)
  const [slot, setSlot] = useState<string | null>(null)
  const [step, setStep] = useState<'day' | 'time' | 'form'>('day')

  const now = useMemo(() => new Date(), [])

  useEffect(() => {
    const tag = navigator.languages?.[0] ?? navigator.language ?? 'en-US'
    setLocale(tag)
    setHour12(new Intl.DateTimeFormat(tag, { hour: 'numeric' }).resolvedOptions().hour12 === true)
  }, [])

  const byDay = useMemo(() => {
    const map = new Map<string, Date[]>()
    for (const iso of slots) {
      const at = new Date(iso)
      const key = dayKeyIn(at, timezone)
      const list = map.get(key)
      if (list) list.push(at)
      else map.set(key, [at])
    }
    return map
  }, [slots, timezone])

  const firstOpen = useMemo(() => [...byDay.keys()].sort()[0] ?? null, [byDay])
  const [monthKey, setMonthKey] = useState(() => monthKeyOf(dayKeyIn(new Date(), initialTimezone)))

  // Open on the month the times are actually in, not on the month it happens to be.
  // Recomputed when the zone changes, because a first opening at 23:30 on the last
  // of the month is the first of the next one somewhere else.
  useEffect(() => {
    if (firstOpen) setMonthKey(monthKeyOf(firstOpen))
  }, [firstOpen])

  const week = useMemo(() => weekInfo(locale), [locale])
  const zones = useMemo(() => knownTimezones(timezone), [timezone])
  const cells = useMemo(() => monthCells(monthKey, week.firstDay), [monthKey, week.firstDay])
  const daySlots = day ? (byDay.get(day) ?? []) : []
  const monthIsEmpty = cells.every((cell) => !cell || (byDay.get(cell)?.length ?? 0) === 0)

  return (
    <div className="rawr-b-panel" data-step={step}>
      <div className="rawr-b-rhead">
        <h2>Pick a new time</h2>
        <TimezonePicker
          timezone={timezone}
          zones={zones}
          at={now}
          open={tzOpen}
          onToggle={() => setTzOpen((was) => !was)}
          onPick={(next) => {
            setTimezone(next)
            setTzOpen(false)
            setSlot(null)
            setDay(null)
            setStep('day')
          }}
        />
      </div>

      <div className="rawr-b-split">
        <div className="rawr-b-pane" data-side="left">
          <Calendar
            monthKey={monthKey}
            cells={cells}
            byDay={byDay}
            weekdays={week.weekdays}
            selected={day}
            today={dayKeyIn(now, timezone)}
            locale={locale}
            loading={false}
            onMonth={(by) => {
              setMonthKey(shiftMonth(monthKey, by))
              setDay(null)
              setSlot(null)
              setStep('day')
            }}
            onDay={(target) => {
              setDay(target)
              setSlot(null)
              setStep('time')
            }}
          />
        </div>

        <div className="rawr-b-pane" data-side="right">
          {slot ? (
            <form action={action} className="rawr-b-form">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="tz" value={timezone} />
              <input type="hidden" name="slot" value={slot} />

              <div className="rawr-b-rhead">
                <button
                  type="button"
                  className="rawr-b-back"
                  onClick={() => {
                    setSlot(null)
                    setStep('time')
                  }}
                >
                  <Icon name="left" />
                  Times
                </button>
                <h2 style={{ flex: 1 }}>Confirm the move</h2>
              </div>

              <p className="rawr-b-summary">
                <span>
                  <b>
                    {formatTime(new Date(slot), timezone, locale, hour12)} –{' '}
                    {formatTime(
                      new Date(new Date(slot).getTime() + durationMinutes * 60_000),
                      timezone,
                      locale,
                      hour12,
                    )}
                  </b>
                  <span>{formatDayLong(dayKeyIn(new Date(slot), timezone), locale)}</span>
                </span>
              </p>

              <PendingButton className="rawr-b-cta" pendingLabel={BOOKING_COPY.moving}>
                Move my meeting
              </PendingButton>
              <p className="rawr-b-hint">
                The old time is released and a fresh invitation goes out. Would rather not meet at
                all? <a href={cancelHref}>Cancel</a>.
              </p>
            </form>
          ) : day === null ? (
            <div className="rawr-b-blank">
              <b>{monthIsEmpty ? 'No open times this month' : BOOKING_COPY.pickDay}</b>
              {firstOpen ? (
                <>
                  <p>The next opening is {formatDayLong(firstOpen, locale)}.</p>
                  <button
                    type="button"
                    className="rawr-b-ghost"
                    onClick={() => {
                      setMonthKey(monthKeyOf(firstOpen))
                      setDay(firstOpen)
                      setStep('time')
                    }}
                  >
                    Go to it
                  </button>
                </>
              ) : (
                <p>{BOOKING_COPY.nothingAtAll}</p>
              )}
            </div>
          ) : (
            <Times
              day={day}
              slots={daySlots}
              timezone={timezone}
              locale={locale}
              hour12={hour12}
              loading={false}
              duration={durationMinutes}
              onHour12={setHour12}
              onBack={() => setStep('day')}
              onPick={(iso) => {
                setSlot(iso)
                setStep('form')
              }}
            />
          )}
        </div>
      </div>

      <p className="rawr-b-hint">
        Times shown in {timezone} {offsetLabel(timezone, now)}.
      </p>
    </div>
  )
}
