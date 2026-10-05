import { headers } from 'next/headers'
import { weekInfoFor } from './edge-copy.ts'
import { localeFrom } from './format.ts'

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

export const visitorLocale = async (): Promise<VisitorLocale> => {
  const tag = localeFrom((await headers()).get('accept-language'))

  // The same function the embed script inlines, so a visitor sees the same week
  // whether the calendar is hosted here or embedded in somebody's site.
  return { tag, ...weekInfoFor(tag) }
}
