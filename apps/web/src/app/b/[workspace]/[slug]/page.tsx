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
import { PendingButton } from '~/components/pending-button.tsx'
import { BOOKING_STYLES, HOSTED_BOOKING_STYLES } from '~/lib/booking-styles.ts'
import {
  BOOKING_COPY,
  BOOKING_LOCATIONS,
  bookingHosts,
  bookingNextAvailable,
  hourIn,
  slotBandOf,
} from '~/lib/edge-copy.ts'
import { bookingIcsPath, bookingPublicPath } from '~/lib/links.ts'
import { visitorLocale } from '~/lib/visitor-locale.ts'
import { loadOffer, nextAvailableAfter } from '~/server/booking.ts'
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
  // The page's own name, not "Book " plus it: pages are usually already named
  // for the action ("Book time with me"), and prefixing produced "Book Book time
  // with me" in the browser tab.
  return {
    title: page ? `${page.name} · ${page.workspaceName}` : 'Book a meeting',
    robots: { index: false },
  }
}

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

  const locale = await visitorLocale()

  const summary = await publicBookingPage(workspace, slug)
  if (!summary) notFound()

  // The confirmation path needs the templates and the fallback copy, which the
  // public resolver deliberately does not return. Reading them takes a workspace
  // scope, and by this point the slug has named one.
  const page = await readBookingPage(publicEdgeContext(summary.workspaceId), summary.bookingPageId)
  if (!page) notFound()

  const now = new Date()
  // Whether the visitor's zone is a choice or a fallback. The server cannot know a
  // browser's timezone, so the page renders in UTC and the picker replaces that
  // with the detected zone on first paint. Once tz is in the URL it is a decision
  // and is never overridden again, which is what makes a shared link stable. F2 §4.
  const explicitTimezone = isKnownTimezone(single('tz') ?? '')
  const timezone = explicitTimezone ? (single('tz') as string) : 'UTC'
  const requested = single('month')
  const monthKey = /^\d{4}-\d{2}$/.test(requested ?? '') ? (requested as string) : monthKeyOf(now, timezone)

  const confirmed = single('confirmed') === '1'
  const problem = single('e')

  if (confirmed) {
    return (
      <Shell page={summary} timezone={timezone} explicitTimezone={explicitTimezone} monthKey={monthKey} workspace={workspace} slug={slug}>
        <div className="rawr-b-note" data-good>
          <p>
            <strong>{BOOKING_COPY.booked}</strong>{' '}
            {page.confirmationCopy ??
              'A calendar invitation is on its way to your inbox, with the joining details and links to move or cancel the meeting.'}
          </p>
          {single('at') ? (
            <p style={{ marginBlockStart: '0.5rem' }}>
              {new Date(single('at') as string).toLocaleString(locale.tag, {
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
          {/* Google invites the mailbox they gave us, which is not always the
              calendar they keep. This is the meeting as a file for the one they do. */}
          {single('r') ? (
            <p style={{ marginBlockStart: '0.5rem' }}>
              <a href={bookingIcsPath(single('r') as string)}>{BOOKING_COPY.addToCalendar}</a>
            </p>
          ) : null}
          {single('r') ? (
            <p style={{ marginBlockStart: '0.5rem' }}>
              <a href={`/b/manage/reschedule/${single('r')}`}>{BOOKING_COPY.reschedule}</a>
              {single('c') ? (
                <>
                  {' · '}
                  <a href={`/b/manage/cancel/${single('c')}`}>{BOOKING_COPY.cancel}</a>
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
      <Shell page={summary} timezone={timezone} explicitTimezone={explicitTimezone} monthKey={monthKey} workspace={workspace} slug={slug}>
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

  // Only when the month is genuinely empty and availability was actually
  // established: "nothing until December" is a lie when the truth is that no
  // calendar could be read.
  const nextOpen =
    offer.slots.length === 0 && !offer.unavailable ? await nextAvailableAfter(page, to) : null

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

  const days = calendarDays(monthKey, locale.firstDay)
  const todayKey = dayKey(now, timezone)
  const fields = bookingFields(page.questions)
  const errors = parseErrors(single('err'))

  return (
    <Shell page={summary} timezone={timezone} explicitTimezone={explicitTimezone} monthKey={monthKey} workspace={workspace} slug={slug}>
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
          {nextOpen ? (
            <>
              <p>
                {bookingNextAvailable(
                  nextOpen.toLocaleDateString(locale.tag, {
                    timeZone: timezone,
                    weekday: 'long',
                    day: 'numeric',
                    month: 'long',
                  }),
                )}
              </p>
              {/* One click rather than several: the month and the day the times
                  are actually on, not just the direction to walk in. */}
              <a
                className="rawr-b-cta"
                style={{ display: 'inline-block', marginBlockStart: '0.5rem', textDecoration: 'none' }}
                href={bookingPublicPath(workspace, slug, {
                  tz: timezone,
                  month: dayKey(nextOpen, timezone).slice(0, 7),
                  date: dayKey(nextOpen, timezone),
                })}
                rel="nofollow"
              >
                {BOOKING_COPY.jumpToNext}
              </a>
            </>
          ) : (
            BOOKING_COPY.nothingAtAll
          )}
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
            <span className="rawr-b-month">{monthLabel(monthKey, locale.tag)}</span>
            <a
              className="rawr-b-slot"
              style={{ padding: '0.25rem 0.5rem' }}
              href={link({ month: nextMonthKey(monthKey, 1), date: undefined, slot: undefined })}
              rel="nofollow"
            >
              Later →
            </a>
          </div>

          {/* Not role="grid": that promises rows of gridcells, and this is seven
              CSS columns of links. A grid with no rows in it announces as an
              empty grid, which is worse than the group this actually is. */}
          {/* biome-ignore lint/a11y/useSemanticElements: not a form control set
              and not a data table either. It is seven columns of day links with
              a name, which is exactly what role="group" describes. */}
          <div className="rawr-b-grid" role="group" aria-label={`Open days in ${monthLabel(monthKey, locale.tag)}`}>
            {locale.weekdays.map((label) => (
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
                  today={day === todayKey}
                  href={link({ date: day, slot: undefined })}
                />
              ),
            )}
          </div>
        </div>

        {selectedDay ? (
          <div className="rawr-b-panel">
            <h2 style={{ marginBlockEnd: '0.5rem' }}>
              {new Date(`${selectedDay}T12:00:00Z`).toLocaleDateString(locale.tag, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </h2>

            {daySlots.length === 0 ? (
              <p className="rawr-b-hint">{BOOKING_COPY.nothingOnDay}</p>
            ) : (
              // Named runs rather than one column of forty buttons. A band with
              // nothing in it is not drawn, so a nine-to-five day shows two.
              bandsOf(daySlots, timezone).map(([band, slots]) => (
                <div key={band} className="rawr-b-band">
                  <h3 className="rawr-b-bandname">{band}</h3>
                  <div className="rawr-b-times">
                    {slots.map((slot) => {
                      const iso = slot.toISOString()
                      return (
                        <a
                          key={iso}
                          className="rawr-b-slot"
                          aria-current={iso === selectedSlot ? 'true' : undefined}
                          href={link({ date: selectedDay, slot: iso })}
                          rel="nofollow"
                        >
                          {slot.toLocaleTimeString(locale.tag, {
                            timeZone: timezone,
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </a>
                      )
                    })}
                  </div>
                </div>
              ))
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

                <PendingButton className="rawr-b-cta" pendingLabel={BOOKING_COPY.booking}>
                  Confirm {page.durationMinutes} minutes
                </PendingButton>
                <p className="rawr-b-hint">
                  Times shown in {timezone}. You will get a calendar invitation with the joining
                  details and a link to move or cancel.
                </p>
              </form>
            ) : null}
          </div>
        ) : offer.slots.length > 0 ? (
          <p className="rawr-b-hint">{BOOKING_COPY.pickDay}</p>
        ) : null}
      </div>
    </Shell>
  )
}

const Shell = ({
  page,
  timezone,
  explicitTimezone,
  monthKey,
  workspace,
  slug,
  children,
}: {
  page: PublicBookingPage
  timezone: string
  explicitTimezone: boolean
  monthKey: string
  workspace: string
  slug: string
  children: React.ReactNode
}) => (
  // The page width is set on a wrapper rather than on the widget itself. The embed
  // stylesheet declares max-width:100% on [data-rawr-booking-widget], and that rule
  // is unlayered while Tailwind's utilities live in @layer utilities, so a max-w-*
  // class on the same element silently loses. Keeping the two on separate elements
  // means neither has to know about the other, and the embed CSS stays unlayered
  // where it belongs: inside somebody else's page it must beat their stylesheet.
  <div className="mx-auto w-full max-w-3xl p-4">
    <div data-rawr-booking-widget data-rawr-booking-hosted>
      <style dangerouslySetInnerHTML={{ __html: BOOKING_STYLES + HOSTED_BOOKING_STYLES }} />
      <div className="rawr-b">
        <header className="rawr-b-head">
          <span className="rawr-b-title">{page.name}</span>
          <div className="rawr-b-meta">
            <span>{page.workspaceName}</span>
            {page.hostNames.length > 0 ? <span>{bookingHosts(page.hostNames)}</span> : null}
            <span>{page.durationMinutes} minutes</span>
            <span>{BOOKING_LOCATIONS[page.location] ?? page.location}</span>
          </div>
          <TimezonePicker
            timezone={timezone}
            explicit={explicitTimezone}
            basePath={bookingPublicPath(workspace, slug, { month: monthKey })}
          />
        </header>
        {children}
      </div>
    </div>
  </div>
)

const DayCell = ({
  day,
  count,
  selected,
  today,
  href,
}: {
  day: string
  count: number
  selected: boolean
  today: boolean
  href: string
}) => {
  const label = day.slice(8).replace(/^0/, '')
  if (count === 0) {
    // The words are in the DOM rather than in an aria-label: a span carries no
    // role, and a label on an element with no role is not announced at all, so
    // the closed days used to read as a bare run of numbers.
    return (
      <span className="rawr-b-day" data-closed {...(today ? { 'data-today': '' } : {})}>
        {label}
        <span className="rawr-b-off">, nothing open</span>
      </span>
    )
  }
  return (
    <a
      className="rawr-b-day"
      data-open
      {...(today ? { 'data-today': '' } : {})}
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

/** The day's times, in the order they happen, split into the runs a person reads
 *  them in. Insertion order is preserved by Map, and the slots arrive sorted. */
const bandsOf = (slots: Date[], timezone: string): [string, Date[]][] => {
  const bands = new Map<string, Date[]>()
  for (const slot of slots) {
    const band = slotBandOf(hourIn(slot, timezone))
    const list = bands.get(band)
    if (list) list.push(slot)
    else bands.set(band, [slot])
  }
  return [...bands]
}

/** A whole month, padded to start on whichever weekday the visitor's locale
 *  begins its week on, so the grid lines up under the weekday headings. Monday in
 *  most of Europe, Sunday in the US, Saturday across much of the Middle East. */
const calendarDays = (monthKey: string, firstDay: number): (string | null)[] => {
  const first = `${monthKey}-01`
  const pad = (isoWeekday(first) - firstDay + 7) % 7
  const cells: (string | null)[] = Array.from({ length: pad }, () => null)
  for (let day = first; day.startsWith(monthKey); day = addDays(day, 1)) cells.push(day)
  return cells
}

const monthLabel = (monthKey: string, tag: string): string =>
  new Date(`${monthKey}-01T12:00:00Z`).toLocaleDateString(tag, {
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
