import { type useRouter, useSearchParams } from 'next/navigation'
import { hrefWith, replaceParams } from './url-history.ts'

export { pushParams, replaceParams } from './url-history.ts'

/** Closes what the address holds, then refreshes the page. replaceParams moves the
 *  address without a render, so the router still holds the list as it rendered
 *  before the panel opened, and a replace back to that query reuses it. The refresh
 *  is queued after the replace, so it fetches the list again. */
export const closeParamsAndRefresh = (router: ReturnType<typeof useRouter>, changes: Record<string, string | null>): void => {
  router.replace(hrefWith(window.location.pathname, window.location.search, changes), { scroll: false })
  router.refresh()
}

/** One query parameter as state: what a dialog that has to survive a refresh or
 *  be pasted to somebody keeps its open-ness in, as `?edit=<id>`. */
export const useUrlParam = (key: string): [string | null, (value: string | null) => void] => [
  useSearchParams().get(key),
  (value) => replaceParams({ [key]: value }),
]
