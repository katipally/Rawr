/** The path with `changes` applied to its query string. Pure, so the address math
 *  is testable without a window. */
export const hrefWith = (pathname: string, search: string, changes: Record<string, string | null>): string => {
  const params = new URLSearchParams(search)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key)
    else params.set(key, value)
  }
  const query = params.toString()
  return `${pathname}${query ? `?${query}` : ''}`
}

const write = (method: 'pushState' | 'replaceState', changes: Record<string, string | null>): void =>
  window.history[method](null, '', hrefWith(window.location.pathname, window.location.search, changes))

/** Changes query parameters on the address in place, with no history entry. The
 *  History API is what Next's `useSearchParams` follows without asking the server
 *  for the page again, which is what makes a panel that lives in the address open
 *  and close instantly. Client only. */
export const replaceParams = (changes: Record<string, string | null>): void => write('replaceState', changes)

/** The same change as a history entry, so Back steps back through it. For a tab
 *  or a filter the person picked: Back should undo that, not close a panel. */
export const pushParams = (changes: Record<string, string | null>): void => write('pushState', changes)
