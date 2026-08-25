/** D17, the SEM container. The feature is deferred; the capture is not, because
 *  traffic that arrives before this exists is permanently unattributable.
 *
 *  The rule is that nothing in the query string is dropped on the way in. Known
 *  UTM keys are lifted out for reporting, and the raw string is kept beside them,
 *  so a `gclid`, an `msclkid`, an `li_fat_id` or whatever the next ad platform
 *  invents is already stored the day someone asks for it. No backfill, ever. */

export type Attribution = {
  rawQuery: string | null
  referrer: string | null
  landingPage: string | null
  pagePath: string | null
  userAgent: string | null
  utm: {
    source: string | null
    medium: string | null
    campaign: string | null
    term: string | null
    content: string | null
  }
  firstSeenAt: string
}

export type AttributionInput = {
  rawQuery?: string | null
  referrer?: string | null
  landingPage?: string | null
  pagePath?: string | null
  userAgent?: string | null
  firstSeenAt?: Date | string | null
}

/** Long enough for a real campaign URL, short enough that a megabyte of junk in
 *  the referrer header cannot be used to bloat the table. */
const MAX_LENGTH = 2048

const clip = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim()
  if (!trimmed) return null
  return trimmed.length > MAX_LENGTH ? trimmed.slice(0, MAX_LENGTH) : trimmed
}

export const readAttribution = (input: AttributionInput): Attribution => {
  const rawQuery = clip(input.rawQuery)
  const params = new URLSearchParams(rawQuery?.startsWith('?') ? rawQuery.slice(1) : (rawQuery ?? ''))
  const utm = (key: string): string | null => clip(params.get(`utm_${key}`))

  const seen = input.firstSeenAt
  const firstSeenAt =
    seen instanceof Date
      ? seen.toISOString()
      : typeof seen === 'string' && !Number.isNaN(Date.parse(seen))
        ? new Date(seen).toISOString()
        : new Date().toISOString()

  return {
    rawQuery,
    referrer: clip(input.referrer),
    landingPage: clip(input.landingPage),
    pagePath: clip(input.pagePath),
    userAgent: clip(input.userAgent),
    utm: {
      source: utm('source'),
      medium: utm('medium'),
      campaign: utm('campaign'),
      term: utm('term'),
      content: utm('content'),
    },
    firstSeenAt,
  }
}

/** What `original_source` and `latest_source` hold on contact, company and deal.
 *  A short readable channel plus the evidence it was derived from, so a later
 *  change of heart about channel rules can be re-derived rather than re-collected. */
export const sourceFrom = (attribution: Attribution): { channel: string; detail: Attribution } => ({
  channel: channelOf(attribution),
  detail: attribution,
})

const PAID_KEYS = ['gclid', 'msclkid', 'li_fat_id', 'fbclid', 'ttclid']

const channelOf = (attribution: Attribution): string => {
  const params = new URLSearchParams(
    attribution.rawQuery?.startsWith('?')
      ? attribution.rawQuery.slice(1)
      : (attribution.rawQuery ?? ''),
  )
  if (PAID_KEYS.some((key) => params.has(key))) return 'Paid Search'
  if (attribution.utm.medium) {
    const medium = attribution.utm.medium.toLowerCase()
    if (medium.includes('cpc') || medium.includes('paid')) return 'Paid Search'
    if (medium.includes('email')) return 'Email Marketing'
    if (medium.includes('social')) return 'Social Media'
    return 'Other Campaigns'
  }
  if (attribution.utm.source) return 'Other Campaigns'

  const referrer = attribution.referrer
  if (!referrer) return 'Direct Traffic'
  try {
    const host = new URL(referrer).hostname.toLowerCase()
    if (/(^|\.)(google|bing|duckduckgo|yahoo|ecosia|brave)\./.test(host)) return 'Organic Search'
    if (/(^|\.)(linkedin|twitter|x|facebook|instagram|reddit|youtube|t)\./.test(host)) {
      return 'Social Media'
    }
    return 'Referrals'
  } catch {
    return 'Referrals'
  }
}
