import { createHash } from 'node:crypto'
import { isFreeMailDomain, registrableDomain } from './domains.ts'
import { HONEYPOT_FIELD } from './form-schema.ts'

/** F3 §5. The weights are the spec, not a tuning knob someone changed casually.
 *  Every one of them is additive and every one records a reason, so a score is
 *  always explainable to the person reviewing a false positive. */
export const SPAM_WEIGHTS = {
  honeypot: 40,
  tooFast: 30,
  stalePage: 10,
  duplicateContent: 25,
  disposableDomain: 30,
  tooManyLinks: 20,
  /** Not in the table: a no-JS submission cannot carry the honeypot or the timing
   *  token, and scoring their absence would block every person with JavaScript
   *  off. The absence is worth something, but far less than a filled honeypot. */
  noSignals: 15,
} as const

export const QUARANTINE_AT = 30
export const CONFIRMED_SPAM_AT = 70

/** Under two seconds is not a person reading a form. */
export const MIN_FILL_SECONDS = 2
/** Over twelve hours means the page was left open, or a token is being replayed. */
export const MAX_FILL_SECONDS = 12 * 60 * 60

export type SpamSignal = {
  rule: keyof typeof SPAM_WEIGHTS
  points: number
  detail: string
}

export type SpamVerdict = {
  score: number
  state: 'clean' | 'quarantined' | 'confirmed_spam'
  reasons: SpamSignal[]
  /** Turnstile is invisible below 30 and challenged from 30 to 69. Above that the
   *  submission is spam regardless of what a challenge would have said. */
  needsChallenge: boolean
}

export type SpamInput = {
  /** Raw posted body, before the schema allowlist strips it. The honeypot and the
   *  timing token live here and nowhere else. */
  raw: Record<string, unknown>
  /** Answers after the allowlist, which is what the link and duplicate checks read. */
  answers: Record<string, unknown>
  email: string | null
  /** Seconds the page was open, or null when the path carries no timing token. */
  fillSeconds: number | null
  /** True when the submission came through the no-JS hosted page or a webhook,
   *  where honeypot and timing checks do not apply. */
  degradedSignals: boolean
  /** True when an identical set of answers landed on this form in the last 60s. */
  duplicateWithin60s: boolean
}

const LINK = /\b(?:https?:\/\/|www\.)\S+/gi

const countLinks = (answers: Record<string, unknown>): number => {
  let total = 0
  for (const value of Object.values(answers)) {
    if (typeof value !== 'string') continue
    total += value.match(LINK)?.length ?? 0
  }
  return total
}

const stateFor = (score: number): SpamVerdict['state'] => {
  if (score >= CONFIRMED_SPAM_AT) return 'confirmed_spam'
  if (score >= QUARANTINE_AT) return 'quarantined'
  return 'clean'
}

/** Pure, so it is testable without a database and behaves identically on the
 *  hosted page, the embed and the Webflow webhook. */
export const scoreSubmission = (input: SpamInput): SpamVerdict => {
  const reasons: SpamSignal[] = []
  const add = (rule: keyof typeof SPAM_WEIGHTS, detail: string) =>
    reasons.push({ rule, points: SPAM_WEIGHTS[rule], detail })

  const honeypot = input.raw[HONEYPOT_FIELD]
  if (typeof honeypot === 'string' && honeypot.trim() !== '') {
    add('honeypot', 'A field hidden from people was filled in.')
  }

  if (input.degradedSignals) {
    add('noSignals', 'Submitted without JavaScript, so timing and honeypot checks could not run.')
  } else if (input.fillSeconds !== null) {
    if (input.fillSeconds < MIN_FILL_SECONDS) {
      add('tooFast', `Submitted ${input.fillSeconds.toFixed(1)}s after the form loaded.`)
    } else if (input.fillSeconds > MAX_FILL_SECONDS) {
      add('stalePage', 'The form had been open for more than twelve hours.')
    }
  } else {
    add('noSignals', 'The submission carried no timing token.')
  }

  if (input.duplicateWithin60s) {
    add('duplicateContent', 'The identical answers were submitted less than a minute ago.')
  }

  const domain = registrableDomain(input.email)
  if (domain && isFreeMailDomain(domain) && DISPOSABLE.has(domain)) {
    add('disposableDomain', `${domain} is a throwaway mail provider.`)
  }

  const links = countLinks(input.answers)
  if (links > 2) add('tooManyLinks', `The answers contain ${links} links.`)

  const score = reasons.reduce((total, reason) => total + reason.points, 0)
  return {
    score,
    reasons,
    state: stateFor(score),
    needsChallenge: score >= QUARANTINE_AT && score < CONFIRMED_SPAM_AT,
  }
}

/** Applied after a challenge is attempted, because a passed challenge is evidence
 *  and an unreachable one is not. Fails closed to quarantine: never accept, never
 *  reject outright, always leave the lead reviewable. */
export const applyChallenge = (
  verdict: SpamVerdict,
  outcome: 'passed' | 'failed' | 'unavailable',
): SpamVerdict => {
  if (!verdict.needsChallenge) return verdict
  if (outcome === 'passed') {
    return { ...verdict, score: verdict.score, state: 'clean', needsChallenge: false }
  }
  const detail =
    outcome === 'failed'
      ? 'The bot challenge was failed or the token was already used.'
      : 'The bot challenge could not be reached, so this is held for review rather than accepted.'
  return {
    ...verdict,
    state: 'quarantined',
    needsChallenge: false,
    reasons: [...verdict.reasons, { rule: 'noSignals', points: 0, detail }],
  }
}

/** The throwaway providers, a strict subset of the free-mail list in domains.ts.
 *  A gmail.com address is a real person using a personal address; a mailinator
 *  one is not, and only the latter should score. */
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'dispostable.com',
  'maildrop.cc', 'getnada.com', 'mailnesia.com', 'spamgourmet.com', 'example.com',
])

/** An IP is personal data and is never stored raw. The salt rotates daily, so a
 *  hash stops being a stable identifier after a day while still supporting the
 *  rate limit and the duplicate check inside their own windows. */
export const hashIp = (ip: string | null, salt: string, day = new Date()): string | null => {
  if (!ip) return null
  const stamp = day.toISOString().slice(0, 10)
  return createHash('sha256').update(`${salt}:${stamp}:${ip}`).digest('hex').slice(0, 32)
}

/** Canonical form of an answer set, for the sixty-second duplicate check. Key
 *  order and whitespace must not decide whether two posts are the same. */
export const answersFingerprint = (answers: Record<string, unknown>): string => {
  const normalised = Object.keys(answers)
    .sort()
    .map((key) => `${key}=${String(answers[key] ?? '').trim().toLowerCase()}`)
    .join('&')
  return createHash('sha256').update(normalised).digest('hex').slice(0, 32)
}
