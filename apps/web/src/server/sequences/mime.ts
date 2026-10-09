import { randomUUID } from 'node:crypto'

/** Building the message Gmail sends.
 *
 *  RFC 5322 by hand rather than a library, because what has to be right here is
 *  small and specific: the threading headers, the one-click unsubscribe, and an
 *  encoding that survives a subject with an em dash in it. A library would bring
 *  a MIME parser we have no use for. */

export type OutgoingLink = { token: string; url: string }

export type Recipient = { name?: string | undefined; address: string }

/** A file read from storage, ready to be encoded into the message. */
export type OutgoingFile = { filename: string; mime: string; bytes: Uint8Array }

export type BuildInput = {
  from: { name: string; address: string }
  to: Recipient[]
  cc?: Recipient[] | undefined
  /** Gmail takes the Bcc header to deliver to these people and removes it from the copy
   *  each recipient receives, so writing it here does not show it to anyone else. */
  bcc?: Recipient[] | undefined
  /** Where a reply goes when it is not the sender. */
  replyTo?: Recipient[] | undefined
  subject: string
  text: string
  html: string | null
  attachments?: OutgoingFile[] | undefined
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

/** RFC 2047 caps an encoded word at 75 characters. Forty-five bytes of UTF-8 is
 *  sixty base64 characters, which leaves room for the wrapper. */
const WORD_BYTES = 45

/** Anything outside ASCII in a header has to be encoded, or a subject with a
 *  curly quote in it arrives as mojibake. A long one is split into several words,
 *  cut between characters so no UTF-8 sequence is torn across two. */
export const encodeHeader = (value: string): string => {
  const clean = value.replaceAll(/[\r\n]+/g, ' ').trim()
  // eslint-disable-next-line no-control-regex
  if (!/[^ -~]/.test(clean)) return clean
  const words: string[] = []
  let chunk = ''
  for (const character of clean) {
    if (Buffer.byteLength(chunk + character) > WORD_BYTES) {
      words.push(chunk)
      chunk = ''
    }
    chunk += character
  }
  words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ')
}

/** A display name with a comma or a quote in it has to be quoted, or the address
 *  parses as two recipients. */
export const addressHeader = (name: string, address: string): string => {
  // An address is written as it is, so a CR or LF in it would start a header of its own.
  if (/[\r\n\s<>,;"]/.test(address)) throw new Error('A recipient address has a character a mail header cannot carry.')
  if (!name.trim()) return address
  const encoded = encodeHeader(name)
  return /[",:;<>@]/.test(encoded) ? `"${encoded.replaceAll('"', '\\"')}" <${address}>` : `${encoded} <${address}>`
}

/** One address to a line. Folding after each comma keeps every header line under the
 *  998 characters RFC 5322 allows, however many people are on it. */
const addressList = (recipients: Recipient[]): string =>
  recipients.map((recipient) => addressHeader(recipient.name ?? '', recipient.address)).join(',\r\n ')

const SAFE_MIME = /^[a-z]+\/[a-z0-9.+-]+$/

/** The stored type when it is a plausible one, otherwise the type that means "bytes". */
const mimeOf = (mime: string): string => {
  const clean = mime.trim().toLowerCase()
  return SAFE_MIME.test(clean) ? clean : 'application/octet-stream'
}

/** RFC 2231 percent-encoding, which also covers the four characters that encoding
 *  leaves alone but a parameter may not carry. */
const percent = (text: string): string =>
  encodeURIComponent(text).replaceAll(/['()*!]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)

/** A parameter such as name or filename, as one or more segments. Plain ASCII is
 *  quoted. Anything else is split into RFC 2231 continuations of twenty characters
 *  each, so no single line grows past the header limit. Encoded words are not used
 *  here: RFC 2047 does not allow them inside a parameter. */
const parameter = (key: string, value: string): string[] => {
  if (/^[\x20-\x7e]+$/.test(value) && !/["\\]/.test(value) && value.length <= 150) return [`${key}="${value}"`]
  const characters = [...value]
  const pieces = Array.from({ length: Math.ceil(characters.length / 20) }, (_, index) =>
    characters.slice(index * 20, index * 20 + 20).join(''),
  )
  return pieces.map((piece, index) => (index === 0 ? `${key}*0*=UTF-8''${percent(piece)}` : `${key}*${index}*=${percent(piece)}`))
}

/** A header with its parameters, one per folded line, so each stays short. */
const withParams = (header: string, value: string, params: string[]): string[] => [
  `${header}: ${value}${params.length > 0 ? ';' : ''}`,
  ...params.map((param, index) => ` ${param}${index < params.length - 1 ? ';' : ''}`),
]

const attachmentPart = (file: OutgoingFile): string[] => {
  const filename = file.filename.replaceAll(/[\r\n\0]+/g, ' ').trim() || 'file'
  const named = parameter('name', filename)
  const base64 = Buffer.from(file.bytes).toString('base64').match(/.{1,76}/g) ?? []
  return [
    ...withParams('Content-Type', mimeOf(file.mime), named),
    'Content-Transfer-Encoding: base64',
    ...withParams('Content-Disposition', 'attachment', parameter('filename', filename)),
    '',
    ...base64,
  ]
}

/** The text, or the text and HTML as two alternatives, with the headers that open it. */
const textOrAlternative = (text: string, html: string | null): string[] => {
  if (!html) {
    return [
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      quotedPrintable(text),
    ]
  }
  const boundary = `rawr-${randomUUID()}`
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(text),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(html),
    '',
    `--${boundary}--`,
  ]
}

/** Quoted-printable, so a body with an accent in it is not mangled and a line
 *  longer than 998 characters does not break the message. base64 would be simpler
 *  and would make every mail unreadable in a plain-text client's source view. */
export const quotedPrintable = (value: string): string => {
  const encoded = value
    .replaceAll('\r\n', '\n')
    // Code points, not UTF-16 units: an emoji is two units and must not be encoded as two halves.
    .split(/(?:)/u)
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

/** The body first, then each file as its own part of one mixed message. */
const withAttachments = (body: string[], files: OutgoingFile[]): string[] => {
  const boundary = `rawr-${randomUUID()}`
  return [
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    ...body,
    ...files.flatMap((file) => [`--${boundary}`, ...attachmentPart(file)]),
    `--${boundary}--`,
  ]
}

/** The whole message, base64url encoded the way Gmail's send endpoint wants it. */
export const buildMessage = (input: BuildInput): BuiltMessage => {
  const id = messageId(domainOf(input.from.address))
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

  const cc = input.cc ?? []
  const bcc = input.bcc ?? []
  const replyTo = input.replyTo ?? []
  const headers = [
    `From: ${addressHeader(input.from.name, input.from.address)}`,
    `To: ${addressList(input.to)}`,
    ...(cc.length > 0 ? [`Cc: ${addressList(cc)}`] : []),
    ...(bcc.length > 0 ? [`Bcc: ${addressList(bcc)}`] : []),
    ...(replyTo.length > 0 ? [`Reply-To: ${addressList(replyTo)}`] : []),
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

  const text = textOrAlternative(input.text, html)
  const body = input.attachments && input.attachments.length > 0 ? withAttachments(text, input.attachments) : text

  const raw = [...headers, ...body].join('\r\n')
  return { raw: Buffer.from(raw, 'utf8').toString('base64url'), internetMessageId: id, links }
}
