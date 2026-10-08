import { parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5'

type Node = DefaultTreeAdapterTypes.ChildNode
type Parent = DefaultTreeAdapterTypes.ParentNode
type Element = DefaultTreeAdapterTypes.Element

/** Removed with everything inside. Their content is code, styling, a page of its
 *  own, or a form a stranger could use to ask for a password. */
const DROPPED = new Set([
  'script', 'style', 'title', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'applet', 'noembed', 'noframes', 'xmp', 'form', 'input', 'button', 'select', 'textarea', 'svg', 'math',
  'head', 'meta', 'link', 'base',
])

/** Kept with their attributes. Any other element is unwrapped: the tag goes, the text inside stays. */
const KEPT_TAGS = new Set([
  'a', 'abbr', 'address', 'b', 'bdi', 'bdo', 'big', 'blockquote', 'br', 'caption', 'center', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'dfn', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span', 'strike',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'u', 'ul', 'video',
])

const KEPT_ATTRS = new Set([
  'align', 'alt', 'bgcolor', 'border', 'cellpadding', 'cellspacing', 'color', 'colspan', 'dir', 'face', 'height',
  'lang', 'nowrap', 'rowspan', 'size', 'span', 'start', 'title', 'type', 'valign', 'value', 'width',
])

/** Attributes that name a URL, with the schemes each may use. `#` stands for a
 *  same-page anchor. Anything else is dropped, so nothing is fetched or run that
 *  the reader did not ask for. */
const URL_ATTRS = new Map<string, readonly string[]>([
  ['href', ['http:', 'https:', 'mailto:', '#']],
  ['src', ['http:', 'https:']],
  ['background', ['http:', 'https:']],
  ['poster', ['http:', 'https:']],
])

/** Whatever in a style value can fetch a file or run code: a url(), an image
 *  function, an import, an IE expression or behavior, a Mozilla binding, or a CSS
 *  escape that could hide one of those. Matched on the decoded value, so entities
 *  have already been resolved by the parser. */
const UNSAFE_CSS = /url\(|image|@import|expression|behaviou?r|binding|\\/i

/** Browsers ignore tabs and newlines inside a URL and spaces around it, so the
 *  value is cleaned the same way before it is judged, and the cleaned value is what
 *  is written out. The scheme is then decided by the URL parser itself, not by a
 *  pattern that could disagree with it. */
const safeUrl = (value: string, schemes: readonly string[]): string | null => {
  const clean = value.replace(/\s/g, '')
  if (clean.startsWith('#')) return schemes.includes('#') ? clean : null
  if (!URL.canParse(clean)) return null
  return schemes.includes(new URL(clean).protocol) ? clean : null
}

const cleanAttrs = (element: Element): void => {
  element.attrs = element.attrs.flatMap((attr) => {
    if (attr.name === 'style') return UNSAFE_CSS.test(attr.value) ? [] : [attr]
    if (attr.name === 'src' && element.tagName !== 'img') return []
    const schemes = URL_ATTRS.get(attr.name)
    if (schemes) {
      const url = safeUrl(attr.value, schemes)
      if (url === null) return []
      attr.value = url
      return [attr]
    }
    return KEPT_ATTRS.has(attr.name) ? [attr] : []
  })
}

/** What survives a walk: the elements kept, and what each kept element may carry. */
type Policy = { tags: ReadonlySet<string>; attrs: (element: Element) => void }

/** Deeper than real mail is laid out. The serialiser recurses per level and
 *  overflows the stack near 3000 levels when measured, so this stays far below it. */
const MAX_DEPTH = 500

/** Walks with an explicit stack, not recursion, so a deeply nested mail cannot
 *  overflow the call stack. Each node is visited once: O(nodes + attributes). */
const clean = (root: Parent, policy: Policy): void => {
  const pending: [Parent, number][] = [[root, 0]]
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [parent, depth] = next
    const kept: Node[] = []
    const queue: Node[] = parent.childNodes.slice().reverse()
    for (let child = queue.pop(); child; child = queue.pop()) {
      if (child.nodeName === '#text') kept.push(child)
      else if (!('tagName' in child) || DROPPED.has(child.tagName)) continue
      else if (policy.tags.has(child.tagName)) {
        if (depth < MAX_DEPTH) {
          policy.attrs(child)
          kept.push(child)
        }
      } else {
        for (const grandchild of child.childNodes.reverse()) queue.push(grandchild)
      }
    }
    parent.childNodes = kept
    for (const child of kept) {
      child.parentNode = parent
      if ('tagName' in child) pending.push([child, depth + 1])
    }
  }
}

/** Runs before a sender's HTML is stored. The parser is the WHATWG one that a
 *  browser uses, so entities, case, quoting and stray whitespace are resolved the
 *  same way the reader's browser will resolve them. Only what the allow-list names
 *  survives, and the output is re-serialised from that tree, so nothing is written
 *  out that was not kept.
 *
 *  This is the server half of two defences. The mail frame has no scripts and no
 *  popups, and the reader's browser blocks remote images until asked (see
 *  message-frame.ts). Both stay in place if this is ever relaxed. */
export const sanitiseHtml = (html: string): string => {
  const fragment = parseFragment(html)
  clean(fragment, { tags: KEPT_TAGS, attrs: cleanAttrs })
  return serialize(fragment)
}

/** What a person can write in the composer: emphasis, lists, paragraphs and links,
 *  and nothing that styles, positions, embeds or runs. */
const COMPOSED_TAGS = new Set(['a', 'b', 'blockquote', 'br', 'div', 'em', 'i', 'li', 'ol', 'p', 'strong', 'ul'])

/** A link keeps its address only when it is web or mail, and gets rel="noopener"
 *  because a link in a sent mail should not hand the reader's page a reference back. */
const composedAttrs = (element: Element): void => {
  const href = element.attrs.find((attr) => attr.name === 'href')
  const url = element.tagName === 'a' && href ? safeUrl(href.value, ['http:', 'https:', 'mailto:']) : null
  element.attrs = url === null ? [] : [{ name: 'href', value: url }, { name: 'rel', value: 'noopener' }]
}

/** The HTML of an email a person wrote in the composer, cleaned before it is sent. */
export const sanitiseComposed = (html: string): string => {
  const fragment = parseFragment(html)
  clean(fragment, { tags: COMPOSED_TAGS, attrs: composedAttrs })
  return serialize(fragment)
}

const BLOCKS = new Set(['blockquote', 'div', 'p'])

const linked = (element: Element, inner: string): string => {
  const href = element.attrs.find((attr) => attr.name === 'href')?.value ?? ''
  const shown = inner.trim()
  return href === '' || shown === '' || shown === href || `mailto:${shown}` === href ? inner : `${inner} (${href})`
}

const items = (list: Element): string => {
  let number = 0
  return list.childNodes
    .flatMap((child) => ('tagName' in child && child.tagName === 'li' ? [child] : []))
    .map((item) => {
      number += 1
      const marker = list.tagName === 'ol' ? `${number}. ` : '- '
      return marker + text(item).trim().replaceAll(/\s*\n\s*/g, ' ')
    })
    .join('\n')
}

const element = (node: Element): string => {
  if (node.tagName === 'br') return '\n'
  if (node.tagName === 'ul' || node.tagName === 'ol') return `\n${items(node)}\n`
  if (node.tagName === 'a') return linked(node, text(node))
  if (node.tagName === 'blockquote') {
    return `\n${text(node).trim().split('\n').map((line) => `> ${line}`).join('\n')}\n`
  }
  return BLOCKS.has(node.tagName) ? `\n${text(node)}\n` : text(node)
}

const text = (parent: Parent): string => {
  let out = ''
  for (const child of parent.childNodes) {
    if (child.nodeName === '#text') out += (child as DefaultTreeAdapterTypes.TextNode).value.replaceAll(/\s+/g, ' ')
    else if ('tagName' in child) out += element(child)
  }
  return out
}

/** The plain-text part of a composed email, read from its cleaned HTML, so the two
 *  parts say the same thing. Lists keep their markers, a link keeps its address, and
 *  each block keeps its own line. */
export const composedText = (html: string): string =>
  text(parseFragment(html))
    .replaceAll(/[ \t]+\n/g, '\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim()
