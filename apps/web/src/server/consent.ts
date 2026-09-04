/** The first-party consent cookie. Named to say what it is, and deliberately not
 *  named like HubSpot's `__hs_cookie_cat_pref`, because a stale HubSpot cookie
 *  must not be mistaken for a Rawr choice after cutover.
 *
 *  Thirteen months is the standard EU retention ceiling for a consent record, and
 *  the cookie carries the policy version so a policy change re-prompts only the
 *  people whose stored choice predates it. */
export const CONSENT_COOKIE = 'rawr_consent'

/** HubSpot encodes its categories as "1:true" for analytics and "2:true" for
 *  advertisement. A visitor who already chose under HubSpot's banner should not
 *  be asked again on day one of cutover, so their cookie is read once and
 *  translated. 00-context.md §6.
 *
 *  Read only. Rawr never writes this format. */
export const readHubSpotConsent = (
  raw: string | null | undefined,
): { analytics: boolean; advertisement: boolean } | null => {
  if (!raw) return null
  const parts = raw.split(',').map((part) => part.trim())
  let seen = false
  let analytics = false
  let advertisement = false
  for (const part of parts) {
    const [category, value] = part.split(':')
    if (category !== '1' && category !== '2') continue
    // A category with nothing after the colon is a truncated cookie, not a
    // refusal. Counting it as one recorded a choice nobody made and suppressed
    // the banner instead of asking again.
    if (value === undefined) continue
    seen = true
    if (category === '1') analytics = value === 'true'
    else advertisement = value === 'true'
  }
  return seen ? { analytics, advertisement } : null
}

export type ConsentCategories = {
  necessary: true
  analytics: boolean
  advertisement: boolean
}

export const readCategories = (raw: unknown): ConsentCategories | null => {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  if (typeof c.analytics !== 'boolean' || typeof c.advertisement !== 'boolean') return null
  return { necessary: true, analytics: c.analytics, advertisement: c.advertisement }
}
