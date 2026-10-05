import { useSearchParams } from 'next/navigation'

/** Changes query parameters on the address in place, with no history entry. The
 *  History API is what Next's `useSearchParams` follows without asking the server
 *  for the page again, which is what makes a panel that lives in the address open
 *  and close instantly. Client only. */
export const replaceParams = (changes: Record<string, string | null>): void => {
  const params = new URLSearchParams(window.location.search)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key)
    else params.set(key, value)
  }
  const search = params.toString()
  window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`)
}

/** One query parameter as state: what a dialog that has to survive a refresh or
 *  be pasted to somebody keeps its open-ness in, as `?edit=<id>`. */
export const useUrlParam = (key: string): [string | null, (value: string | null) => void] => [
  useSearchParams().get(key),
  (value) => replaceParams({ [key]: value }),
]
