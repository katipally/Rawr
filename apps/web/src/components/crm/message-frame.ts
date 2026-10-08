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
