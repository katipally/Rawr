import { headers } from 'next/headers'

/** Public pages are rendered on the server for people who are not signed in and
 *  are not on our continent. Without this they inherit the server's idea of a
 *  date, which is one arbitrary format imposed on every visitor. The browser
 *  already says what it wants in Accept-Language, so ask.
 *
 *  Not `undefined`: on a server component that resolves to the host process's
 *  locale, which is worse than a wrong guess because it changes with the deploy. */
export type VisitorLocale = {
  /** A BCP-47 tag safe to hand to Intl. */
  tag: string
  /** 1 = Monday … 7 = Sunday, per the locale's own calendar convention. */
  firstDay: number
  /** Short weekday headings, already rotated to start on `firstDay`. */
  weekdays: string[]
}

const FALLBACK = 'en-US'

/** "fr-CA,fr;q=0.9,en;q=0.8" → the first tag Intl actually accepts. */
const preferredTag = (header: string): string => {
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim()
    if (!tag || tag === '*') continue
    try {
      return new Intl.Locale(tag).toString()
    } catch {
      // A malformed tag from one browser must not cost every other visitor a date.
    }
  }
  return FALLBACK
}

export const visitorLocale = async (): Promise<VisitorLocale> => {
  const tag = preferredTag((await headers()).get('accept-language') ?? '')

  // getWeekInfo is ES2024 and present in Node 24, but not yet in TypeScript's
  // Intl lib, so the shape is declared here rather than widened globally.
  const locale = new Intl.Locale(tag) as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number }
  }
  const firstDay = locale.getWeekInfo?.().firstDay ?? 1

  const naming = new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' })
  // 2024-01-01 was a Monday, so ISO weekday n is that date plus (n - 1) days.
  const weekdays = Array.from({ length: 7 }, (_, offset) =>
    naming.format(new Date(Date.UTC(2024, 0, 1 + ((firstDay - 1 + offset) % 7)))),
  )

  return { tag, firstDay, weekdays }
}
