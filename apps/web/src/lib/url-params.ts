import { type useRouter, useSearchParams } from 'next/navigation'
import { hrefWith, replaceParams } from './url-history.ts'

export { pushParams, replaceParams } from './url-history.ts'

/** Closes what the address holds and refreshes the page as one router navigation.
 *  Next drops a refresh that is still in flight when a later address change lands,
 *  so a refresh followed by replaceParams can leave the list stale. */
export const closeParamsAndRefresh = (router: ReturnType<typeof useRouter>, changes: Record<string, string | null>): void =>
  router.replace(hrefWith(window.location.pathname, window.location.search, changes), { scroll: false })

/** One query parameter as state: what a dialog that has to survive a refresh or
 *  be pasted to somebody keeps its open-ness in, as `?edit=<id>`. */
export const useUrlParam = (key: string): [string | null, (value: string | null) => void] => [
  useSearchParams().get(key),
  (value) => replaceParams({ [key]: value }),
]
