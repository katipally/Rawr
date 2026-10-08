/** The one item that is "you are here": the one whose prefix is longest. Reports
 *  and Dashboards share a prefix, so both match a dashboard page; the longer one wins. */
export const currentNavItem = <T extends { href: string; match?: string }>(items: readonly T[], here: string): T | undefined => {
  let best: T | undefined
  let bestLength = -1
  for (const item of items) {
    const prefix = item.match ?? item.href
    if (prefix === '/' ? here !== '/' : !here.startsWith(prefix)) continue
    if (prefix.length > bestLength) {
      best = item
      bestLength = prefix.length
    }
  }
  return best
}
