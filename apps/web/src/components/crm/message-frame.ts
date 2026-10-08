/** No `allow-scripts`, so nothing in a mail runs. No popup grant either: the frame
 *  never opens a window itself. A click on a link is handed to `openMailLink` in the
 *  parent, so a javascript: URL that the sanitiser missed has no frame to run in. */
export const messageFrameSandbox = 'allow-same-origin'

/** Runs in the parent page on a click inside the mail. Web links open in a new tab
 *  with no opener; mailto hands off to the mail client; anything else does nothing. */
export const openMailLink = (event: MouseEvent) => {
  event.preventDefault()
  const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null | undefined
  if (!link) return
  if (/^https?:/i.test(link.href)) window.open(link.href, '_blank', 'noopener,noreferrer')
  else if (/^mailto:/i.test(link.href)) window.location.href = link.href
}

/** Strings and escaped characters are matched so that a `/*` inside them, or an
 *  escaped slash, is not read as a comment. Comments are dropped; the rest is kept. */
const STRING_ESCAPE_OR_COMMENT = /("(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?|\\[\s\S])|\/\*[\s\S]*?(?:\*\/|$)/g
const CSS_HEX_ESCAPE = /\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([\s\S])/gi
const REMOTE_FUNCTION = /(?:url|src|image|image-set)\(|@import/i

/** Whether a CSS value (a style attribute or a style element) can make the browser
 *  fetch something. Reads it the way CSS does: comments go, escapes are decoded, and
 *  names are case-insensitive, so `\75rl(`, `UR/**\/L(` and `u\72l(` all count. */
export const loadsRemotely = (css: string): boolean => {
  const uncommented = css.replace(STRING_ESCAPE_OR_COMMENT, (_, kept?: string) => kept ?? '')
  const decoded = uncommented.replace(CSS_HEX_ESCAPE, (_, hex?: string, char?: string) => {
    if (hex === undefined) return char!
    const code = parseInt(hex, 16)
    return String.fromCodePoint(code === 0 || code > 0x10ffff ? 0xfffd : code)
  })
  return REMOTE_FUNCTION.test(decoded)
}

/** An SVG href the browser follows with no request: a fragment in this document, or
 *  an inline image. Anything else (a web address, a protocol-relative one, a data
 *  URL that is not an image) would fetch from somewhere the reader never chose. */
export const localSvgRef = (value: string): boolean => {
  const clean = value.replace(/\s/g, '')
  return clean.startsWith('#') || /^data:image\//i.test(clean)
}

/** Takes every remote load out of stored mail HTML until the reader asks for them.
 *  The browser's own parser finds the attributes, so a load in any form is caught:
 *  an image, a responsive source set, a table or cell background, a video poster,
 *  a style attribute that calls url() or image(), a style or link element, and an
 *  SVG use, image or feImage href. */
export const blockRemoteLoads = (html: string): { html: string; blocked: number } => {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  let blocked = 0
  for (const element of doc.body.querySelectorAll('use, image, feImage')) {
    for (const name of ['href', 'xlink:href']) {
      const value = element.getAttribute(name)
      if (value !== null && !localSvgRef(value)) {
        element.removeAttribute(name)
        blocked++
      }
    }
  }
  for (const element of doc.body.querySelectorAll('[src],[srcset],[background],[poster],[style]')) {
    let hit = false
    for (const name of ['src', 'srcset', 'background', 'poster']) {
      if (element.hasAttribute(name)) {
        element.removeAttribute(name)
        hit = true
      }
    }
    const style = element.getAttribute('style')
    if (style !== null && loadsRemotely(style)) {
      element.removeAttribute('style')
      hit = true
    }
    if (hit) blocked++
  }
  for (const element of doc.querySelectorAll('style, link')) {
    element.remove()
    blocked++
  }
  return { html: doc.body.innerHTML, blocked }
}
