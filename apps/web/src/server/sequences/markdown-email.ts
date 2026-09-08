import { parse, tokenise, type Block, type Token } from '~/components/crm/markdown.ts'

/** The same Markdown the app renders, as the HTML an email client will show.
 *
 *  One parser, two renderers: `markdown.tsx` builds React for the screen, this
 *  builds a string for the wire. Writing a second parser here is how the preview
 *  and the sent mail drift apart.
 *
 *  Styles are inline because a mail client strips `<style>`, and the tags are the
 *  handful every client has agreed on since the 1990s. No `<div>` layout, no
 *  classes, no web fonts: this is the part of the internet where 2005 never
 *  ended. */

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const P = 'margin:0 0 12px;line-height:1.5'

const inline = (token: Token): string => {
  const text = escapeHtml(token.text)
  if (token.kind === 'strong') return `<strong>${text}</strong>`
  if (token.kind === 'em') return `<em>${text}</em>`
  if (token.kind === 'code') return `<code style="font-family:monospace">${text}</code>`
  // safeHref already refused anything a browser should not follow, and the href is
  // escaped again here because it is going into an attribute.
  if (token.kind === 'link') return `<a href="${escapeHtml(token.href)}">${text}</a>`
  return text
}

const line = (text: string): string => tokenise(text).map(inline).join('')

const block = (entry: Block): string => {
  if (entry.kind === 'h') {
    const size = entry.level === 1 ? 22 : entry.level === 2 ? 18 : 16
    return `<p style="margin:0 0 12px;font-size:${size}px;font-weight:600">${line(entry.text)}</p>`
  }
  if (entry.kind === 'ul' || entry.kind === 'ol') {
    const tag = entry.kind
    const items = entry.items.map((item) => `<li style="margin:0 0 4px">${line(item)}</li>`).join('')
    return `<${tag} style="margin:0 0 12px;padding-left:20px">${items}</${tag}>`
  }
  if (entry.kind === 'quote') {
    return `<blockquote style="margin:0 0 12px;padding-left:12px;border-left:3px solid #d0d0d0;color:#555">${entry.lines.map(line).join('<br />')}</blockquote>`
  }
  return `<p style="${P}">${entry.lines.map(line).join('<br />')}</p>`
}

export const toEmailHtml = (source: string): string => parse(source).map(block).join('')

/** The plain-text half of the same mail. Not `toPlainText`, which joins a whole
 *  note into one line for a table cell: an email keeps its paragraphs, and a
 *  recipient whose client shows text needs to be able to read it. */
export const toEmailText = (source: string): string =>
  parse(source)
    .map((entry) => {
      if (entry.kind === 'h') return plain(entry.text)
      if (entry.kind === 'ul') return entry.items.map((item) => `- ${plain(item)}`).join('\n')
      if (entry.kind === 'ol') return entry.items.map((item, at) => `${at + 1}. ${plain(item)}`).join('\n')
      if (entry.kind === 'quote') return entry.lines.map((each) => `> ${plain(each)}`).join('\n')
      return entry.lines.map(plain).join('\n')
    })
    .join('\n\n')

/** A link keeps its destination, because "click here" with nothing to click is
 *  the one thing a text part must not do. */
const plain = (text: string): string =>
  tokenise(text)
    .map((token) => (token.kind === 'link' && token.text !== token.href ? `${token.text} (${token.href})` : token.text))
    .join('')
