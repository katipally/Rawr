import { randomUUID } from 'node:crypto'

/** Building the message Gmail sends.
 *
 *  RFC 5322 by hand rather than a library, because what has to be right here is
 *  small and specific: the threading headers, the one-click unsubscribe, and an
 *  encoding that survives a subject with an em dash in it. A library would bring
 *  a MIME parser we have no use for. */

export type OutgoingLink = { token: string; url: string }

export type BuildInput = {
  from: { name: string; address: string }
  to: string
  subject: string
  text: string
  html: string | null
  /** Set on a reply so the recipient sees one conversation. */
  inReplyTo?: string | null | undefined
  references?: string[] | undefined
  /** Where the pixel and the click redirects point. */
  trackingBase?: string | null | undefined
  unsubscribeToken?: string | null | undefined
  sendToken?: string | null | undefined
  trackOpens?: boolean | undefined
  trackClicks?: boolean | undefined
}

export type BuiltMessage = {
  raw: string
  internetMessageId: string
  /** Every link that was rewritten, so the rows can be written before it is sent. */
  links: OutgoingLink[]
}

/** A Message-ID has to be globally unique and is what a reply's In-Reply-To will
 *  carry, so it is generated here rather than left to Gmail: the row that records
 *  the send has to know it before the send happens. */
const messageId = (domain: string): string => `<${randomUUID()}@${domain}>`

const domainOf = (address: string): string => address.split('@')[1] ?? 'localhost'

/** Anything outside ASCII in a header has to be encoded, or a subject with a
 *  curly quote in it arrives as mojibake. */
export const encodeHeader = (value: string): string => {
  const clean = value.replaceAll(/[\r\n]+/g, ' ').trim()
  // eslint-disable-next-line no-control-regex
  if (!/[^ -~]/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`
}

/** A display name with a comma or a quote in it has to be quoted, or the address
 *  parses as two recipients. */
const addressHeader = (name: string, address: string): string => {
  if (!name.trim()) return address
  const encoded = encodeHeader(name)
  return /[",:;<>@]/.test(encoded) ? `"${encoded.replaceAll('"', '\\"')}" <${address}>` : `${encoded} <${address}>`
}

/** Quoted-printable, so a body with an accent in it is not mangled and a line
 *  longer than 998 characters does not break the message. base64 would be simpler
 *  and would make every mail unreadable in a plain-text client's source view. */
export const quotedPrintable = (value: string): string => {
  const encoded = value
    .replaceAll('\r\n', '\n')
    .split('')
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      if (character === '\n') return '\n'
      if (character === '=') return '=3D'
      if (code >= 0x20 && code <= 0x7e) return character
      if (character === '\t') return '=09'
      return [...Buffer.from(character, 'utf8')]
        .map((byte) => `=${byte.toString(16).toUpperCase().padStart(2, '0')}`)
        .join('')
    })
    .join('')

  // Soft line breaks at 75, because a hard limit of 76 includes the '=' itself.
  return encoded
    .split('\n')
    .map((line) => {
      const parts: string[] = []
      let current = ''
      for (const piece of line.match(/(=[0-9A-F]{2})|[\s\S]/g) ?? []) {
        if (current.length + piece.length > 73) {
          parts.push(`${current}=`)
          current = ''
        }
        current += piece
      }
      parts.push(current)
      return parts.join('\r\n')
    })
    .join('\r\n')
}

const HREF = /(<a\b[^>]*?\bhref\s*=\s*)("([^"]*)"|'([^']*)')/gi

/** Rewrites every http link to go through the redirect, so a click is counted and
 *  the destination is read from a row rather than from the URL.
 *
 *  Deliberately skips mailto:, tel:, anchors and the unsubscribe link itself: a
 *  redirect on an unsubscribe would make opting out depend on the tracker. */
export const rewriteLinks = (
  html: string,
  base: string,
  skip: (url: string) => boolean,
): { html: string; links: OutgoingLink[] } => {
  const links: OutgoingLink[] = []
  const rewritten = html.replace(HREF, (whole, prefix: string, _quoted: string, double?: string, single?: string) => {
    const url = (double ?? single ?? '').trim()
    if (!/^https?:\/\//i.test(url) || skip(url)) return whole
    const token = randomUUID().replaceAll('-', '')
    links.push({ token, url })
    return `${prefix}"${base}/t/c/${token}"`
  })
  return { html: rewritten, links }
}

/** The whole message, base64url encoded the way Gmail's send endpoint wants it. */
export const buildMessage = (input: BuildInput): BuiltMessage => {
  const id = messageId(domainOf(input.from.address))
  const boundary = `rawr-${randomUUID()}`
  const base = input.trackingBase ?? null

  let html = input.html
  let links: OutgoingLink[] = []
  // Two addresses for the same act: the one in the header is POSTed to by the
  // provider and answers nothing but 200; the one a person clicks is a page that
  // asks first, because mail scanners follow links.
  const unsubscribeUrl = base && input.unsubscribeToken ? `${base}/u/${input.unsubscribeToken}` : null
  const oneClickUrl = base && input.unsubscribeToken ? `${base}/u/one-click/${input.unsubscribeToken}` : null

  if (html && base && input.trackClicks !== false) {
    const rewrote = rewriteLinks(html, base, (url) => (unsubscribeUrl ? url.startsWith(unsubscribeUrl) : false))
    html = rewrote.html
    links = rewrote.links
  }
  if (html && base && input.sendToken && input.trackOpens !== false) {
    // Last thing in the body, so a client that stops rendering early still shows
    // the message. Width and height of one, not zero: a zero-sized image is a
    // spam signal in several filters.
    html = `${html}<img src="${base}/t/o/${input.sendToken}" width="1" height="1" alt="" style="display:block;border:0" />`
  }

  const headers = [
    `From: ${addressHeader(input.from.name, input.from.address)}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    `Message-ID: ${id}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references && input.references.length > 0
      ? [`References: ${input.references.join(' ')}`]
      : input.inReplyTo
        ? [`References: ${input.inReplyTo}`]
        : []),
    // RFC 8058. The header is what puts the unsubscribe button in Gmail's own
    // chrome, which is where people actually look for it.
    ...(oneClickUrl
      ? [`List-Unsubscribe: <${oneClickUrl}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click']
      : []),
  ]

  const body = html
    ? [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        quotedPrintable(input.text),
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        quotedPrintable(html),
        '',
        `--${boundary}--`,
      ]
    : [
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: quoted-printable',
        '',
        quotedPrintable(input.text),
      ]

  const raw = [...headers, ...body].join('\r\n')
  return { raw: Buffer.from(raw, 'utf8').toString('base64url'), internetMessageId: id, links }
}
