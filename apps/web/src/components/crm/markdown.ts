/** Reading Markdown. The decisions only — what the tokens are, what the blocks
 *  are, and which links are safe to follow. Turning any of it into elements is
 *  markdown.tsx's job.
 *
 *  Split so this half can be tested. It is also the half worth testing: whether a
 *  `javascript:` URL becomes a link is a security question, and whether three
 *  bullet lines are one list is the only thing anybody notices when it is wrong. */

/** Inline: **bold**, *italic*, _italic_, `code`, [text](url), and bare URLs.
 *
 *  One expression in one pass rather than nested passes, so a `**` inside a code
 *  span cannot be bolded and a link's URL cannot be italicised. */
const INLINE =
  /(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(_[^_\n]+_)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/g

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'strong' | 'em' | 'code'; text: string }
  | { kind: 'link'; text: string; href: string }

/** Only what a browser will follow to somewhere.
 *
 *  A `javascript:` or `data:` URL is the one way Markdown can still be an attack
 *  once nothing is rendered as markup, so the scheme is checked rather than the
 *  string trusted for looking like a link. */
export const safeHref = (raw: string): string | null => {
  try {
    const url = new URL(raw, 'https://example.invalid')
    const ok = url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
    return ok ? raw : null
  } catch {
    return null
  }
}

export const tokenise = (text: string): Token[] => {
  const out: Token[] = []
  let at = 0

  for (const match of text.matchAll(INLINE)) {
    const start = match.index
    if (start > at) out.push({ kind: 'text', text: text.slice(at, start) })
    const [token] = match

    if (token.startsWith('**')) out.push({ kind: 'strong', text: token.slice(2, -2) })
    else if (token.startsWith('`')) out.push({ kind: 'code', text: token.slice(1, -1) })
    else if (token.startsWith('[')) {
      const split = token.indexOf('](')
      const href = safeHref(token.slice(split + 2, -1))
      // A link nobody should follow is kept as the characters somebody wrote,
      // rather than dropped: the reader can see what was attempted.
      if (href) out.push({ kind: 'link', text: token.slice(1, split), href })
      else out.push({ kind: 'text', text: token })
    } else if (token.startsWith('http')) out.push({ kind: 'link', text: token, href: token })
    else out.push({ kind: 'em', text: token.slice(1, -1) })

    at = start + token.length
  }

  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) })
  return out
}

export type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'h'; level: 1 | 2 | 3; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }

/** Blank lines separate blocks; a run of list markers is one list. */
export const parse = (source: string): Block[] => {
  const blocks: Block[] = []

  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    const last = blocks.at(-1)

    if (!line.trim()) {
      // A blank line closes whatever was open, which is what makes two
      // paragraphs two paragraphs rather than one long one.
      if (last) blocks.push({ kind: 'p', lines: [] })
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'h', level: heading[1]!.length as 1 | 2 | 3, text: heading[2]! })
      continue
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      if (last?.kind === 'ul') last.items.push(bullet[1]!)
      else blocks.push({ kind: 'ul', items: [bullet[1]!] })
      continue
    }

    const numbered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (numbered) {
      if (last?.kind === 'ol') last.items.push(numbered[1]!)
      else blocks.push({ kind: 'ol', items: [numbered[1]!] })
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      if (last?.kind === 'quote') last.lines.push(quote[1]!)
      else blocks.push({ kind: 'quote', lines: [quote[1]!] })
      continue
    }

    if (last?.kind === 'p' && last.lines.length > 0) last.lines.push(line)
    else blocks.push({ kind: 'p', lines: [line] })
  }

  return blocks.filter((block) => block.kind !== 'p' || block.lines.length > 0)
}

/** The same note as one line of plain characters, with the marks taken off.
 *
 *  For a table cell, where a heading, a list and three paragraphs cannot be shown
 *  and the source would put its asterisks on screen. What the reader gets is the
 *  words, clipped by the column; the whole thing is on the record. */
export const toPlainText = (source: string): string =>
  parse(source)
    .map((block) => {
      if (block.kind === 'h') return block.text
      if (block.kind === 'ul' || block.kind === 'ol') return block.items.join(', ')
      return block.lines.join(' ')
    })
    .map((line) => tokenise(line).map((token) => token.text).join(''))
    .join(' · ')
