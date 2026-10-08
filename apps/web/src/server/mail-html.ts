import { parseFragment, serialize, type DefaultTreeAdapterTypes } from 'parse5'

type Node = DefaultTreeAdapterTypes.ChildNode
type Parent = DefaultTreeAdapterTypes.ParentNode

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

const cleanAttrs = (element: DefaultTreeAdapterTypes.Element): void => {
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

/** Deeper than real mail is laid out. The serialiser recurses per level and
 *  overflows the stack near 3000 levels when measured, so this stays far below it. */
const MAX_DEPTH = 500

/** Walks with an explicit stack, not recursion, so a deeply nested mail cannot
 *  overflow the call stack. Each node is visited once: O(nodes + attributes). */
const clean = (root: Parent): void => {
  const pending: [Parent, number][] = [[root, 0]]
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [parent, depth] = next
    const kept: Node[] = []
    const queue: Node[] = parent.childNodes.slice().reverse()
    for (let child = queue.pop(); child; child = queue.pop()) {
      if (child.nodeName === '#text') kept.push(child)
      else if (!('tagName' in child) || DROPPED.has(child.tagName)) continue
      else if (KEPT_TAGS.has(child.tagName)) {
        if (depth < MAX_DEPTH) {
          cleanAttrs(child)
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
  clean(fragment)
  return serialize(fragment)
}
