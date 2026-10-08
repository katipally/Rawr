import { useSearchParams } from 'next/navigation'
import { replaceParams } from './url-history.ts'

export { pushParams, replaceParams } from './url-history.ts'

/** One query parameter as state: what a dialog that has to survive a refresh or
 *  be pasted to somebody keeps its open-ness in, as `?edit=<id>`. */
export const useUrlParam = (key: string): [string | null, (value: string | null) => void] => [
  useSearchParams().get(key),
  (value) => replaceParams({ [key]: value }),
]
