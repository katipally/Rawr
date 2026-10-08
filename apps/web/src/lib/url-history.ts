const write = (method: 'pushState' | 'replaceState', changes: Record<string, string | null>): void => {
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key)
    else params.set(key, value)
  }
  const search = params.toString()
  window.history[method](null, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
}

/** Changes query parameters on the address in place, with no history entry. The
 *  History API is what Next's `useSearchParams` follows without asking the server
 *  for the page again, which is what makes a panel that lives in the address open
 *  and close instantly. Client only. */
export const replaceParams = (changes: Record<string, string | null>): void => write('replaceState', changes)

/** The same change as a history entry, so Back steps back through it. For a tab
 *  or a filter the person picked: Back should undo that, not close a panel. */
export const pushParams = (changes: Record<string, string | null>): void => write('pushState', changes)
