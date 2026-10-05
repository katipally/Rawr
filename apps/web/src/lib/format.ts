/** Every date, number and amount the app writes, in the viewer's locale and zone.
 *
 *  Nothing here reads the runtime's own locale or zone. A server component and the
 *  browser that hydrates it sit in different ones, so a call that leaves either
 *  out writes one string on the server and another in the browser, and React
 *  throws the server's markup away (#418). The three inputs are fixed by the
 *  caller instead: the locale from the viewer's Accept-Language, the zone from the
 *  person's setting, the currency from the account's defaults. */
export type FormatSettings = { locale: string; zone: string; currency: string }

export const FALLBACK: FormatSettings = { locale: 'en-US', zone: 'UTC', currency: 'USD' }

/** "fr-CA,fr;q=0.9,en;q=0.8" becomes the first tag Intl accepts. */
export const localeFrom = (acceptLanguage: string | null | undefined): string => {
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0]?.trim()
    if (!tag || tag === '*') continue
    try {
      return new Intl.Locale(tag).toString()
    } catch {
      // A malformed tag from one browser must not cost every other visitor a date.
    }
  }
  return FALLBACK.locale
}

/** Building an Intl formatter is the expensive part of formatting one value, and a
 *  table of a hundred rows asks for the same one a hundred times. The key space is
 *  locales times zones times shapes, and Accept-Language is whatever a client
 *  sends, so the map is emptied rather than allowed to grow without limit. */
const MAX_HELD = 500
const held = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>()

const hold = <T extends Intl.DateTimeFormat | Intl.NumberFormat | Intl.RelativeTimeFormat>(
  key: string,
  make: () => T,
): T => {
  const found = held.get(key) as T | undefined
  if (found) return found
  if (held.size >= MAX_HELD) held.clear()
  const made = make()
  held.set(key, made)
  return made
}

/** A stored value read as a moment, and whether it is one.
 *
 *  A `date` column is "2026-08-07": a day somebody wrote down, the same day in
 *  every zone. A timestamp is an instant, and which day it falls on depends on
 *  where you are standing. Putting a day through a zone moves it, and leaving an
 *  instant out of one shows the wrong hour, so a day is read as UTC midnight and
 *  written back in UTC while an instant is written in the viewer's zone. */
type Moment = { date: Date; dayOnly: boolean }

const asMoment = (value: unknown): Moment | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : { date: value, dayOnly: false }
  if (typeof value !== 'string' || !value) return null
  const dayOnly = value.length === 10
  const parsed = new Date(dayOnly ? `${value}T00:00:00Z` : value)
  return Number.isNaN(parsed.getTime()) ? null : { date: parsed, dayOnly }
}

/** YYYY-MM-DD for an instant in a zone. Parts rather than a locale's own pattern,
 *  because this is a key that gets compared as a string, not something to read. */
export const dayKey = (at: Date, zone: string): string => {
  const parts = hold(`day|${zone}`, () => new Intl.DateTimeFormat(FALLBACK.locale, {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}`
}

export const todayIn = (zone: string): string => dayKey(new Date(), zone)

export type Amount = { currency: string; amount: number }

export const createFormat = ({ locale, zone, currency: home }: FormatSettings) => {
  const number = (value: number | null | undefined, options?: Intl.NumberFormatOptions): string =>
    typeof value === 'number' && Number.isFinite(value)
      ? hold(`n|${locale}|${JSON.stringify(options ?? {})}`, () => new Intl.NumberFormat(locale, options)).format(value)
      : ''

  /** A moment written in the viewer's zone, or in UTC when it is a day. */
  const at = (value: unknown, options: Intl.DateTimeFormatOptions): string => {
    const moment = asMoment(value)
    if (!moment) return ''
    const timeZone = moment.dayOnly ? 'UTC' : zone
    return hold(`d|${locale}|${timeZone}|${JSON.stringify(options)}`, () => new Intl.DateTimeFormat(locale, { timeZone, ...options })).format(moment.date)
  }

  const today = (): string => todayIn(zone)

  /** Money in the account's currency unless the row names its own. Whole amounts
   *  drop the cents, so a pipeline of round figures is not a column of ".00". */
  const money = (value: unknown, code = home): string => {
    const amount = typeof value === 'number' ? value : value === null || value === '' ? Number.NaN : Number(value)
    if (!Number.isFinite(amount)) return ''
    try {
      return hold(
        `c|${locale}|${code}|${amount % 1 === 0}`,
        () => new Intl.NumberFormat(locale, {
          style: 'currency',
          currency: code,
          maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
        }),
      ).format(amount)
    } catch {
      // An unknown currency code is a data problem, not a reason to render nothing.
      return `${number(amount)} ${code}`
    }
  }

  return {
    locale,
    zone,
    currency: home,
    number,
    at,
    today,
    money,

    /** Totals in more than one currency, side by side: a report never adds dollars
     *  to euros, so what it holds is a list. Nothing won reads as zero, not blank. */
    /** A ratio as a percentage: 0.125 reads "12.5%" in English and "12,5 %" in French. */
    percent: (ratio: number | null | undefined, fractionDigits = 0): string =>
      number(ratio, { style: 'percent', maximumFractionDigits: fractionDigits }),

    /** A size on disk in the unit a person reads: megabytes from one up, otherwise
     *  kilobytes, never "0 KB" for a file that has content. */
    bytes: (size: number | null | undefined): string =>
      typeof size === 'number' && size >= 1024 * 1024
        ? number(size / 1024 / 1024, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 })
        : number(typeof size === 'number' ? Math.max(1, Math.round(size / 1024)) : size, { style: 'unit', unit: 'kilobyte' }),

    amounts: (list: readonly Amount[]): string =>
      list.length === 0 ? money(0) : list.map((each) => money(each.amount, each.currency)).join(', '),

    date: (value: unknown): string => at(value, { year: 'numeric', month: 'short', day: 'numeric' }),
    /** Month and day, for a chart axis where the year is already in the range above
     *  it. An axis is days, never instants, so it reads UTC whatever the input. */
    dayShort: (value: unknown): string => {
      const moment = asMoment(value)
      return moment
        ? hold(`s|${locale}`, () => new Intl.DateTimeFormat(locale, { timeZone: 'UTC', month: 'short', day: 'numeric' })).format(moment.date)
        : ''
    },
    month: (value: unknown): string => at(value, { month: 'long', year: 'numeric' }),
    dateTime: (value: unknown): string => at(value, { dateStyle: 'medium', timeStyle: 'short' }),
    time: (value: unknown): string => at(value, { hour: 'numeric', minute: '2-digit' }),

    /** "3 days ago". Only for a list scanned for recency; anything a reader might
     *  quote gets the full date and time. */
    ago: (value: unknown): string => {
      const date = asMoment(value)?.date
      if (!date) return ''
      const seconds = Math.round((date.getTime() - Date.now()) / 1000)
      const units: [Intl.RelativeTimeFormatUnit, number][] = [['day', 86_400], ['hour', 3_600], ['minute', 60]]
      const [unit, size] = units.find(([, s]) => Math.abs(seconds) >= s) ?? ['minute', 60]
      const amount = Math.trunc(seconds / size)
      return amount === 0
        ? 'just now'
        : hold(`r|${locale}`, () => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })).format(amount, unit)
    },

    /** Before today where the viewer stands. A day is compared as a day; an instant
     *  by the day it falls on in the viewer's zone, not the server's. */
    isPast: (value: unknown): boolean => {
      const moment = asMoment(value)
      if (!moment) return false
      return (moment.dayOnly ? (value as string) : dayKey(moment.date, zone)) < today()
    },
  }
}

export type Format = ReturnType<typeof createFormat>
