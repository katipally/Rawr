/** What a hand-written email may carry, and how the people in it are written. Pure,
 *  so the composer can say what is wrong while somebody types and the send can
 *  refuse the same things again without trusting the browser. */

/** Gmail allows five hundred. This is far under it, so one message cannot fan out
 *  into a list that is slow to build and easy to mistype into. */
export const MAX_RECIPIENTS = 100

/** Gmail's own limit on what one message may carry. */
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024

const MAX_ADDRESS_LENGTH = 254
const MAX_NAME_LENGTH = 200
const MAX_LINK_LENGTH = 2000

export type Recipient = { name: string; address: string }

export type RecipientFields = { to: string; cc: string; bcc: string }

export type Recipients = { to: Recipient[]; cc: Recipient[]; bcc: Recipient[] }

export type Parsed<T> = { ok: true; value: T } | { ok: false; field: keyof RecipientFields | null; error: string }

const shorten = (text: string): string => (text.length > 60 ? `${text.slice(0, 59)}…` : text)

/** Straight and curly double quotes both: a name pasted from a word processor
 *  carries the curly kind. */
const QUOTE = /["“”]/

/** Commas and semicolons separate people, except inside quotes or inside the angle
 *  brackets of "Name <address>", where a comma is part of a name. */
const splitEntries = (raw: string): string[] => {
  const entries: string[] = []
  let current = ''
  let quoted = false
  let angled = false
  for (const char of raw) {
    if (QUOTE.test(char) && !angled) quoted = !quoted
    else if (char === '<' && !quoted) angled = true
    else if (char === '>' && !quoted) angled = false
    else if ((char === ',' || char === ';') && !quoted && !angled) {
      entries.push(current)
      current = ''
      continue
    }
    current += char
  }
  entries.push(current)
  return entries.map((entry) => entry.trim()).filter(Boolean)
}

/** Lowercased, with an internationalised domain written as the ASCII form a mail
 *  server routes on. Null when it is not an address. */
export const normaliseAddress = (raw: string): string | null => {
  const at = raw.lastIndexOf('@')
  if (at < 1) return null
  const local = raw.slice(0, at)
  const domain = raw.slice(at + 1)
  if (!/^[^\s"(),:;<>@[\]\\]+$/u.test(local) || !/^[^\s/?#\\:@]+$/u.test(domain)) return null
  let host: string
  try {
    host = new URL(`http://${domain}`).hostname
  } catch {
    return null
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null
  const address = `${local.toLowerCase()}@${host}`
  return address.length <= MAX_ADDRESS_LENGTH ? address : null
}

const parseEntry = (entry: string): Parsed<Recipient> => {
  const named = /^(.*)<([^<>]*)>$/.exec(entry)
  const name = (named?.[1] ?? '').trim().replace(/^["“”](.*)["“”]$/u, '$1').trim().slice(0, MAX_NAME_LENGTH)
  const address = normaliseAddress((named?.[2] ?? entry).trim())
  if (address === null) return { ok: false, field: null, error: `That is not an email address: ${shorten(entry)}` }
  return { ok: true, value: { name, address } }
}

const parseField = (field: keyof RecipientFields, raw: string): Parsed<Recipient[]> => {
  const recipients: Recipient[] = []
  for (const entry of splitEntries(raw)) {
    const parsed = parseEntry(entry)
    if (!parsed.ok) return { ok: false, field, error: parsed.error }
    recipients.push(parsed.value)
  }
  return { ok: true, value: recipients }
}

/** Each address once across the whole message, the first place it appears winning:
 *  someone on To and on Cc is written as To, and someone on Bcc who is already
 *  visible is not sent a second copy. */
export const withoutRepeats = (recipients: Recipients): Recipients => {
  const seen = new Set<string>()
  const keep = (list: Recipient[]): Recipient[] =>
    list.filter((recipient) => {
      if (seen.has(recipient.address)) return false
      seen.add(recipient.address)
      return true
    })
  return { to: keep(recipients.to), cc: keep(recipients.cc), bcc: keep(recipients.bcc) }
}

/** What the three fields mean as people, or the first thing wrong with them. */
export const readRecipients = (fields: RecipientFields): Parsed<Recipients> => {
  if (fields.to.trim() === '') return { ok: false, field: 'to', error: 'Add someone to send it to.' }
  const to = parseField('to', fields.to)
  if (!to.ok) return to
  const cc = parseField('cc', fields.cc)
  if (!cc.ok) return cc
  const bcc = parseField('bcc', fields.bcc)
  if (!bcc.ok) return bcc

  const recipients = withoutRepeats({ to: to.value, cc: cc.value, bcc: bcc.value })
  const count = recipients.to.length + recipients.cc.length + recipients.bcc.length
  if (count > MAX_RECIPIENTS) {
    return { ok: false, field: null, error: `A message can have at most ${MAX_RECIPIENTS} recipients. This one has ${count}.` }
  }
  return { ok: true, value: recipients }
}

const dedupe = (addresses: string[]): string[] => {
  const seen = new Set<string>()
  return addresses.filter((address) => {
    const key = address.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Reply all. To is whoever wrote the newest inbound mail, or, when the newest mail
 *  is one of ours, whoever it went to. Cc is everyone else on it. Our own addresses
 *  are never written back to ourselves. `from` is null for an outbound message.
 *  Reply-To is not kept on the message, so the sender is the address replied to. */
export const replyAllRecipients = (
  original: { from: string | null; to: string[]; cc: string[] },
  own: string[],
): { to: string[]; cc: string[] } => {
  const mine = new Set(own.map((address) => address.toLowerCase()))
  const free = (addresses: string[]): string[] => dedupe(addresses.filter((address) => !mine.has(address.toLowerCase())))
  const to = free(original.from ? [original.from] : original.to)
  const taken = new Set(to.map((address) => address.toLowerCase()))
  const others = free([...(original.from ? original.to : []), ...original.cc])
  return { to, cc: others.filter((address) => !taken.has(address.toLowerCase())) }
}

export const megabytes = (bytes: number): string => (Math.ceil((bytes / 1024 / 1024) * 10) / 10).toFixed(1)

/** Null when the files fit. The same sentence whether the total is judged in the
 *  browser or on the server. */
export const attachmentTotalError = (bytes: number): string | null =>
  bytes > MAX_MESSAGE_BYTES
    ? `Attachments can be ${MAX_MESSAGE_BYTES / 1024 / 1024} MB in total. This message has ${megabytes(bytes)} MB.`
    : null

/** Where a typed link goes. A bare address becomes mailto, a bare host becomes
 *  https, and anything whose scheme is not one of those three is refused, so a
 *  link in a sent mail can never be a script. Null when nothing usable was typed. */
export const linkTarget = (raw: string): string | null => {
  const text = raw.trim()
  if (text === '' || text.length > MAX_LINK_LENGTH) return null
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text)
    ? text
    : /^[^\s@]+@[^\s@]+$/.test(text)
      ? `mailto:${text}`
      : `https://${text}`
  if (!URL.canParse(candidate)) return null
  return ['http:', 'https:', 'mailto:'].includes(new URL(candidate).protocol) ? candidate : null
}
