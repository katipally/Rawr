/** A short name for the browser and system a sign-in came from. Read once, at
 *  sign-in, so the sessions list can tell devices apart without keeping the whole
 *  user agent string. Order matters: Edge, Opera and Android Chrome all also say
 *  "Chrome", and iPhones say "Mac OS X", so the more specific pattern comes first. */

const BROWSERS: [string, RegExp][] = [
  ['Edge', /Edg\//],
  ['Opera', /OPR\//],
  ['Chrome', /Chrome\/|CriOS\//],
  ['Firefox', /Firefox\/|FxiOS\//],
  ['Safari', /Safari\//],
]

const SYSTEMS: [string, RegExp][] = [
  ['iPhone', /iPhone/],
  ['iPad', /iPad/],
  ['Android', /Android/],
  ['Windows', /Windows/],
  ['macOS', /Macintosh|Mac OS X/],
  ['ChromeOS', /CrOS/],
  ['Linux', /Linux/],
]

const first = (table: [string, RegExp][], ua: string): string | null => table.find(([, pattern]) => pattern.test(ua))?.[0] ?? null

export const deviceLabel = (userAgent: string | null): string => {
  const ua = userAgent?.trim() ?? ''
  if (!ua) return 'Unknown device'
  const browser = first(BROWSERS, ua) ?? 'Browser'
  const system = first(SYSTEMS, ua)
  return system ? `${browser} on ${system}` : browser
}
