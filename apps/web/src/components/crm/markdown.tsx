import type { ReactNode } from 'react'
import { parse, tokenise } from './markdown.ts'

/** Markdown, rendered to React elements.
 *
 *  Deliberately not to an HTML string. Nothing in Rawr has ever put user text
 *  through `dangerouslySetInnerHTML` — the only uses anywhere are our own
 *  stylesheets — and rendering to elements is what keeps that true: an angle
 *  bracket somebody types stays a character, because it never becomes markup on
 *  any path. There is no sanitiser here because there is nothing to sanitise.
 *
 *  A small grammar on purpose, and the one people already type without being
 *  told to: headings, bullet and numbered lists, quotes, bold, italic, inline
 *  code, and links. Anything else shows as the characters it is, which is the
 *  right answer for a note on a record. */

const inline = (text: string, keyPrefix: string): ReactNode[] =>
  tokenise(text).map((token, index) => {
    const key = `${keyPrefix}-${index}`
    switch (token.kind) {
      case 'strong':
        return <strong key={key}>{token.text}</strong>
      case 'em':
        return <em key={key}>{token.text}</em>
      case 'code':
        return (
          <code key={key} className="rounded-hs bg-fill px-1">
            {token.text}
          </code>
        )
      case 'link':
        return (
          <a key={key} href={token.href} rel="noreferrer noopener" target="_blank">
            {token.text}
          </a>
        )
      default:
        return token.text
    }
  })

/** Spacing lives here rather than on a parent, so the same note reads the same in
 *  a panel, a preview and a timeline entry. */
export const Markdown = ({ source, className }: { source: string; className?: string }) => {
  const blocks = parse(source)
  if (blocks.length === 0) return null

  return (
    <div className={`flex min-w-0 flex-col gap-2${className ? ` ${className}` : ''}`}>
      {blocks.map((block, index) => {
        const key = String(index)

        if (block.kind === 'h') {
          const size = block.level === 1 ? 'text-lg' : block.level === 2 ? 'text-body' : 'text-small'
          return (
            <p key={key} className={`${size} font-medium`}>
              {inline(block.text, key)}
            </p>
          )
        }

        if (block.kind === 'ul' || block.kind === 'ol') {
          const List = block.kind === 'ul' ? 'ul' : 'ol'
          const items = block.items
          return (
            <List key={key} className={block.kind === 'ul' ? 'ml-5 list-disc' : 'ml-5 list-decimal'}>
              {items.map((item, at) => (
                <li key={`${key}-${at}`}>{inline(item, `${key}-${at}`)}</li>
              ))}
            </List>
          )
        }

        if (block.kind === 'quote') {
          return (
            <blockquote key={key} className="border-l-2 border-line pl-3 text-secondary">
              {inline(block.lines.join(' '), key)}
            </blockquote>
          )
        }

        return (
          <p key={key} className="break-words">
            {inline(block.lines.join(' '), key)}
          </p>
        )
      })}
    </div>
  )
}
