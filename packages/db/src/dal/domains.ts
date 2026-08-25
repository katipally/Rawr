import { psl } from './public-suffix.ts'

/** Free, consumer and disposable mail providers. An address at one of these tells
 *  us nothing about an employer, so it must never become a company. A4.
 *  Deliberately not exhaustive: the check below also refuses anything whose
 *  registrable domain is a known public suffix, which catches the long tail. */
const FREE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
  'msn.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'ymail.com', 'rocketmail.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.de', 'gmx.net', 'web.de', 'mail.com', 'mail.ru', 'yandex.ru', 'yandex.com',
  'zoho.com', 'fastmail.com', 'hushmail.com', 'tutanota.com', 'tuta.io',
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com', 'foxmail.com', 'naver.com',
  'daum.net', 'hanmail.net', 'rediffmail.com', 'yahoo.co.in', 'ymail.co.in',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net',
  'btinternet.com', 'sky.com', 'orange.fr', 'wanadoo.fr', 'free.fr', 'laposte.net',
  't-online.de', 'libero.it', 'virgilio.it', 'telkom.net', 'yahoo.co.id',
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'dispostable.com',
  'maildrop.cc', 'getnada.com', 'mailnesia.com', 'spamgourmet.com', 'example.com',
])

/** Takes anything a person might paste (a URL, an email, a bare host, with or
 *  without www) and returns the registrable domain. Public-suffix aware, so
 *  acme.co.uk stays acme.co.uk and never collapses to co.uk.
 *
 *  This is the one function that normalises a domain. Import, forms, Gmail
 *  matching and the record UI all call it, so two callers can never disagree
 *  about whether "https://WWW.Acme.com/pricing" is the same company as "acme.com". */
export const registrableDomain = (input: string | null | undefined): string | null => {
  if (!input) return null
  let value = input.trim().toLowerCase()
  if (!value) return null

  // An email: everything after the last @ is the host.
  const at = value.lastIndexOf('@')
  if (at !== -1) value = value.slice(at + 1)

  // A URL, with or without a scheme. Strip scheme, credentials, port, path.
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  value = value.replace(/^[^/@]*@/, '')
  value = value.split(/[/?#]/)[0] ?? ''
  value = value.split(':')[0] ?? ''
  value = value.replace(/\.+$/, '')

  if (!value || !value.includes('.') || /\s/.test(value)) return null
  // An IP address is not a registrable domain.
  if (/^[\d.]+$/.test(value)) return null

  const parsed = psl.parse(value)
  if ('error' in parsed || !parsed.domain) return null
  // No second-level label means this is a bare public suffix, not a domain
  // anyone can register: "co.uk" is not a company.
  if (!parsed.sld) return null
  return parsed.domain
}

/** True when a domain identifies a person's mail provider rather than an employer.
 *
 *  Membership of the list is the whole test. An earlier version also refused
 *  anything psl could not find on the public suffix list, which is wrong: that
 *  flag is false for every TLD newer than the bundled list, so real employers on
 *  new gTLDs were being thrown away. registrableDomain already refuses input with
 *  no registrable label. */
export const isFreeMailDomain = (domain: string | null | undefined): boolean => {
  const registrable = registrableDomain(domain)
  if (!registrable) return true
  return FREE_DOMAINS.has(registrable)
}

/** The domain a contact's email implies an employer at, or null when it implies none. */
export const employerDomainFromEmail = (email: string | null | undefined): string | null => {
  const domain = registrableDomain(email)
  if (!domain || isFreeMailDomain(domain)) return null
  return domain
}

/** A readable company name guessed from a domain, used only when creating a company
 *  we have no name for. "acme-labs.co.uk" becomes "Acme Labs". */
export const companyNameFromDomain = (domain: string): string => {
  const label = domain.split('.')[0] ?? domain
  return label
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export const normaliseEmail = (email: string | null | undefined): string | null => {
  const value = email?.trim().toLowerCase()
  if (!value) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null
}
