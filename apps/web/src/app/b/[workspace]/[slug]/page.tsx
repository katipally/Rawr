import {
  addDays,
  bookingFields,
  dayKey,
  isKnownTimezone,
  isoWeekday,
  publicBookingPage,
  publicEdgeContext,
  readBookingPage,
  zonedTimeToUtc,
  type FormField,
  type PublicBookingPage,
} from '@rawr/db'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { BOOKING_STYLES, HOSTED_BOOKING_STYLES } from '~/lib/booking-styles.ts'
import { bookingPublicPath } from '~/lib/links.ts'
import { loadOffer } from '~/server/booking.ts'
import { confirmHostedBooking } from './actions.ts'
import { TimezonePicker } from './timezone-picker.tsx'

/** The public booking page. F2 §4 and §7.
 *
 *  Every step is a URL: the month in view, the day chosen, the slot chosen, the
 *  timezone. That is not decoration. It means the whole thing works with no
 *  JavaScript at all, the back button behaves, and a colleague can be sent the
 *  exact screen somebody is looking at. The one script on the page detects the
 *  visitor's timezone and offers to switch to it, and the page is complete without
 *  it. */

export const dynamic = 'force-dynamic'

export const generateMetadata = async ({
  params,
}: {
  params: Promise<{ workspace: string; slug: string }>
}): Promise<Metadata> => {
  const { workspace, slug } = await params
  const page = await publicBookingPage(workspace, slug)
  return { title: page ? `Book ${page.name}` : 'Book a meeting', robots: { index: false } }
}

const LOCATIONS: Record<string, string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  phone: 'Phone call',
  custom: 'See the invitation',
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const monthKeyOf = (at: Date, timezone: string): string => dayKey(at, timezone).slice(0, 7)

const monthStart = (monthKey: string, timezone: string): Date =>
  zonedTimeToUtc(`${monthKey}-01`, 0, timezone)

const nextMonthKey = (monthKey: string, by: number): string => {
  const [year = 1970, month = 1] = monthKey.split('-').map(Number)
  const shifted = new Date(Date.UTC(year, month - 1 + by, 1))
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`
}

const BookingPublicPage = async ({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string; slug: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) => {
  const { workspace, slug } = await params
  const query = await searchParams
  const single = (key: string): string | null => {
    const value = query[key]
    return typeof value === 'string' && value !== '' ? value : null
  }

  const summary = await publicBookingPage(workspace, slug)
  if (!summary) notFound()

  // The confirmation path needs the templates and the fallback copy, which the
  // public resolver deliberately does not return. Reading them takes a workspace
  // scope, and by this point the slug has named one.
  const page = await readBookingPage(publicEdgeContext(summary.workspaceId), summary.bookingPageId)
  if (!page) notFound()

  const now = new Date()
  const timezone = isKnownTimezone(single('tz') ?? '') ? (single('tz') as string) : 'UTC'
  const requested = single('month')
  const monthKey = /^\d{4}-\d{2}$/.test(requested ?? '') ? (requested as string) : monthKeyOf(now, timezone)

  const confirmed = single('confirmed') === '1'
  const problem = single('e')

  if (confirmed) {
    return (
      <Shell page={summary} timezone={timezone} monthKey={monthKey} workspace={workspace} slug={slug}>
        <div className="rawr-b-note" data-good>
          <p>
            <strong>You are booked.</strong>{' '}
            {page.confirmationCopy ??
              'A calendar invitation is on its way to your inbox, with the joining details and links to move or cancel the meeting.'}
          </p>
          {single('at') ? (
            <p style={{ marginBlockStart: '0.5rem' }}>
              {new Date(single('at') as string).toLocaleString('en-GB', {
                timeZone: timezone,
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
              })}{' '}
              ({timezone})
            </p>
          ) : null}
          {single('w') ? <p style={{ marginBlockStart: '0.5rem' }}>{single('w')}</p> : null}
          {single('r') ? (
            <p style={{ marginBlockStart: '0.5rem' }}>
              <a href={`/b/manage/reschedule/${single('r')}`}>Move this meeting</a>
              {single('c') ? (
                <>
                  {' · '}
                  <a href={`/b/manage/cancel/${single('c')}`}>Cancel it</a>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </Shell>
    )
  }

  if (!page.isActive) {
    return (
      <Shell page={summary} timezone={timezone} monthKey={monthKey} workspace={workspace} slug={slug}>
        <div className="rawr-b-note" data-bad>
          This page is not taking new meetings at the moment. Existing bookings still stand, and the
          reschedule link in your invitation still works.
        </div>
      </Shell>
    )
  }

  const from = monthStart(monthKey, timezone)
  const to = monthStart(nextMonthKey(monthKey, 1), timezone)
  const offer = await loadOffer(page, { from, to, now })

  // Grouped by the visitor's own calendar date, because that is the date they are
  // clicking on. A 23:30 slot in Los Angeles is the next day in Jakarta, and the
  // person in Jakarta is right.
  const byDay = new Map<string, Date[]>()
  for (const slot of offer.slots) {
    const key = dayKey(slot.startsAt, timezone)
    const list = byDay.get(key) ?? []
    list.push(slot.startsAt)
    byDay.set(key, list)
  }

  const selectedDay = single('date')
  const daySlots = selectedDay ? (byDay.get(selectedDay) ?? []) : []
  const selectedSlot = single('slot')
  const slotIsStillOffered =
    selectedSlot !== null && daySlots.some((slot) => slot.toISOString() === selectedSlot)

  const link = (changes: { date?: string | undefined; slot?: string | undefined; month?: string }): string =>
    bookingPublicPath(workspace, slug, { tz: timezone, month: monthKey, ...changes })

  const days = calendarDays(monthKey)
  const fields = bookingFields(page.questions)
  const errors = parseErrors(single('err'))

  return (
    <Shell page={summary} timezone={timezone} monthKey={monthKey} workspace={workspace} slug={slug}>
      {problem ? (
        <div className="rawr-b-note" data-bad role="alert">
          {problem}
        </div>
      ) : null}

      {offer.unavailable ? (
        <div className="rawr-b-note" data-bad role="alert">
          {offer.unavailable}
        </div>
      ) : offer.slots.length === 0 ? (
        <div className="rawr-b-note">
          Nothing is open in {monthLabel(monthKey)}. Try the next month, or{' '}
          <a href={`https://www.datasaur.ai/contact-us`}>send a message instead</a>.
        </div>
      ) : null}

      <div className="rawr-b-body" {...(selectedDay ? { 'data-two': '' } : {})}>
        <div className="rawr-b-panel">
          <div className="rawr-b-monthbar">
            <a
              className="rawr-b-slot"
              style={{ padding: '0.25rem 0.5rem' }}
              href={link({ month: nextMonthKey(monthKey, -1), date: undefined, slot: undefined })}
              rel="nofollow"
            >
              ← Earlier
            </a>
            <span className="rawr-b-month">{monthLabel(monthKey)}</span>
            <a
              className="rawr-b-slot"
              style={{ padding: '0.25rem 0.5rem' }}
              href={link({ month: nextMonthKey(monthKey, 1), date: undefined, slot: undefined })}
              rel="nofollow"
            >
              Later →
            </a>
          </div>

          <div className="rawr-b-grid" role="grid" aria-label={`Open days in ${monthLabel(monthKey)}`}>
            {DOW.map((label) => (
              <div key={label} className="rawr-b-dow" aria-hidden="true">
                {label}
              </div>
            ))}
            {days.map((day, index) =>
              day === null ? (
                <span key={`pad-${index}`} />
              ) : (
                <DayCell
                  key={day}
                  day={day}
                  count={byDay.get(day)?.length ?? 0}
                  selected={day === selectedDay}
                  href={link({ date: day, slot: undefined })}
                />
              ),
            )}
          </div>
        </div>

        {selectedDay ? (
          <div className="rawr-b-panel">
            <h2 style={{ marginBlockEnd: '0.5rem' }}>
              {new Date(`${selectedDay}T12:00:00Z`).toLocaleDateString('en-GB', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </h2>

            {daySlots.length === 0 ? (
              <p className="rawr-b-hint">Nothing open on this day. Pick another.</p>
            ) : (
              <div className="rawr-b-times">
                {daySlots.map((slot) => {
                  const iso = slot.toISOString()
                  return (
                    <a
                      key={iso}
                      className="rawr-b-slot"
                      aria-current={iso === selectedSlot ? 'true' : undefined}
                      href={link({ date: selectedDay, slot: iso })}
                      rel="nofollow"
                    >
                      {slot.toLocaleTimeString('en-GB', {
                        timeZone: timezone,
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </a>
                  )
                })}
              </div>
            )}

            {selectedSlot && !slotIsStillOffered ? (
              <div className="rawr-b-note" data-bad role="alert" style={{ marginBlockStart: '0.75rem' }}>
                That time is no longer open. The list above is current.
              </div>
            ) : null}

            {selectedSlot && slotIsStillOffered ? (
              <form action={confirmHostedBooking} className="rawr-b-form" style={{ marginBlockStart: '0.75rem' }}>
                <input type="hidden" name="rawr_workspace" value={workspace} />
                <input type="hidden" name="rawr_slug" value={slug} />
                <input type="hidden" name="rawr_slot" value={selectedSlot} />
                <input type="hidden" name="rawr_tz" value={timezone} />
                <input type="hidden" name="rawr_month" value={monthKey} />
                <input type="hidden" name="rawr_date" value={selectedDay} />

                {fields.map((field) => (
                  <QuestionInput key={field.key} field={field} error={errors[field.key]} />
                ))}

                <button type="submit" className="rawr-b-cta">
                  Confirm {page.durationMinutes} minutes
                </button>
                <p className="rawr-b-hint">
                  Times shown in {timezone}. You will get a calendar invitation with the joining
                  details and a link to move or cancel.
                </p>
              </form>
            ) : null}
          </div>
        ) : offer.slots.length > 0 ? (
          <p className="rawr-b-hint">Pick a day to see the times that are open.</p>
        ) : null}
      </div>
    </Shell>
  )
}

const Shell = ({
  page,
  timezone,
  monthKey,
  workspace,
  slug,
  children,
}: {
  page: PublicBookingPage
  timezone: string
  monthKey: string
  workspace: string
  slug: string
  children: React.ReactNode
}) => (
  <div data-rawr-booking-widget data-rawr-booking-hosted className="mx-auto w-full max-w-3xl p-4">
    <style dangerouslySetInnerHTML={{ __html: BOOKING_STYLES + HOSTED_BOOKING_STYLES }} />
    <div className="rawr-b">
      <header className="rawr-b-head">
        <span className="rawr-b-title">{page.name}</span>
        <div className="rawr-b-meta">
          <span>{page.workspaceName}</span>
          <span>{page.durationMinutes} minutes</span>
          <span>{LOCATIONS[page.location] ?? page.location}</span>
        </div>
        <TimezonePicker
          timezone={timezone}
          basePath={bookingPublicPath(workspace, slug, { month: monthKey })}
        />
      </header>
      {children}
    </div>
  </div>
)

const DayCell = ({
  day,
  count,
  selected,
  href,
}: {
  day: string
  count: number
  selected: boolean
  href: string
}) => {
  const label = day.slice(8).replace(/^0/, '')
  if (count === 0) {
    return (
      <span className="rawr-b-day" data-closed aria-label={`${day}, nothing open`}>
        {label}
      </span>
    )
  }
  return (
    <a
      className="rawr-b-day"
      data-open
      aria-current={selected ? 'date' : undefined}
      aria-label={`${day}, ${count === 1 ? '1 time' : `${count} times`} open`}
      href={href}
      rel="nofollow"
    >
      {label}
      <span className="rawr-b-dot" aria-hidden="true" />
    </a>
  )
}

/** A whole month, padded to start on the Monday of its first week, so the grid
 *  lines up under the weekday headings. */
const calendarDays = (monthKey: string): (string | null)[] => {
  const first = `${monthKey}-01`
  const pad = isoWeekday(first) - 1
  const cells: (string | null)[] = Array.from({ length: pad }, () => null)
  for (let day = first; day.startsWith(monthKey); day = addDays(day, 1)) cells.push(day)
  return cells
}

const monthLabel = (monthKey: string): string =>
  new Date(`${monthKey}-01T12:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  })

/** Per-field errors come back through the URL because a no-JS round trip has
 *  nowhere else to put them, and a redirect is what keeps a refresh from posting
 *  the booking twice. */
const parseErrors = (raw: string | null): Record<string, string> => {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

const QuestionInput = ({ field, error }: { field: FormField; error?: string | undefined }) => {
  const id = `rawr-q-${field.key}`
  const common = {
    id,
    name: field.key,
    required: field.required,
    ...(error ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {}),
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
        <select {...common} defaultValue="">
          <option value="">Choose one…</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'multi_select' ? (
        <select {...common} multiple>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      ) : field.type === 'boolean' ? (
        <input {...common} type="checkbox" value="true" style={{ width: 'auto' }} />
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
          {error}
        </p>
      ) : field.help ? (
        <p className="rawr-b-hint">{field.help}</p>
      ) : null}
    </div>
  )
}

export default BookingPublicPage
