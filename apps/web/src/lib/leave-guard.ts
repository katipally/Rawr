/** A link that takes the person to another page of the app or the web. A link to
 *  the same path and query only moves within the page, so it leaves nothing. */
export const leavesPage = (href: string, here: URL): boolean => {
  const next = new URL(href, here)
  return next.origin !== here.origin || next.pathname !== here.pathname || next.search !== here.search
}
