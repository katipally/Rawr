/** F2 §5. The template engine behind an event title and description.
 *
 *  Deliberately not a template language. It substitutes `{{a.b}}` from a flat map
 *  and does nothing else: no loops, no conditionals, no filters, no partials. The
 *  production strings are two lines of text with four variables in them, and a
 *  general-purpose engine here would be a new attack surface on a string that ends
 *  up on somebody's calendar.
 *
 *  Two rules matter. An unresolved variable renders as nothing, never as the literal
 *  `{{company.name}}` and never as "undefined". And the result is tidied, so a
 *  title whose tail resolved to nothing does not end in a dangling separator. */

export type TemplateValues = Record<string, string | null | undefined>

const PLACEHOLDER = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi

/** Collapses the wreckage a missing value leaves behind: doubled spaces, and a
 *  trailing separator where the last variable was the whole tail. Without this,
 *  "Discovery Session with Datasaur <> {{company.name}}" with no company becomes
 *  "Discovery Session with Datasaur <> ", which is what §5 forbids. */
const tidy = (value: string): string =>
  value
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[\s]*(?:<>|[-–—:|,])\s*$/, '')
    .trim()

export const renderTemplate = (template: string, values: TemplateValues): string => {
  const filled = template.replace(PLACEHOLDER, (_match, key: string) => {
    const value = values[key.toLowerCase()]
    return typeof value === 'string' ? value.trim() : ''
  })
  return tidy(filled)
}

/** Which variables a template asks for, so the page editor can show a person what
 *  they typed against what a page can actually supply. */
export const templateVariables = (template: string): string[] => {
  const found = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER)) {
    const key = match[1]
    if (key) found.add(key.toLowerCase())
  }
  return [...found]
}

/** Every variable a booking template may use. Anything outside this list resolves
 *  to nothing, which is why the editor lists them. */
export const BOOKING_TEMPLATE_KEYS = [
  'contact.first_name',
  'contact.last_name',
  'contact.full_name',
  'contact.email',
  'company.name',
  'host.name',
  'host.email',
  'page.name',
  'meeting.duration',
] as const

export type BookingTemplateInput = {
  attendeeName: string
  attendeeEmail: string
  companyName: string | null
  /** What `company.name` becomes when nothing is known, so a title never trails
   *  off. Comes from the page, because what reads naturally differs per page. */
  companyFallback: string
  hostName: string
  hostEmail: string
  pageName: string
  durationMinutes: number
}

export const bookingTemplateValues = (input: BookingTemplateInput): TemplateValues => {
  const [first = '', ...rest] = input.attendeeName.trim().split(/\s+/).filter(Boolean)
  return {
    'contact.first_name': first,
    'contact.last_name': rest.join(' '),
    'contact.full_name': input.attendeeName.trim(),
    'contact.email': input.attendeeEmail,
    'company.name': input.companyName?.trim() || input.companyFallback,
    'host.name': input.hostName,
    'host.email': input.hostEmail,
    'page.name': input.pageName,
    'meeting.duration': `${input.durationMinutes} minutes`,
  }
}
