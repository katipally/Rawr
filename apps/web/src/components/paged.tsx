'use client'

import { Pagination } from '@rawr/ui'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ReactNode } from 'react'

/** The first size the per-page control offers, so a settings list opens short
 *  and the reader decides when to make it long. */
const DEFAULT_PER_PAGE = 25

/** One slice of a list the page already holds, plus the pager that moves it.
 *
 *  These lists search and filter in the browser over every row they were given,
 *  so cutting the query short at the database would make a search miss matches
 *  that are only on a later page. Paging is therefore what gets rendered, not
 *  what gets read. Where the reader is lives in the URL, so a reload, a back
 *  button and a shared link all land on the same page. */
export const usePagedRows = <Row,>(
  rows: Row[],
  noun: string,
): { page: Row[]; pager: ReactNode; offset: number } => {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const perPage = Math.max(1, Number(params.get('per')) || DEFAULT_PER_PAGE)
  // A hand-edited or now-too-large offset lands on the last page rather than on
  // nothing, which is also what happens when a search shortens the list.
  const lastOffset = Math.max(0, Math.floor(Math.max(rows.length - 1, 0) / perPage) * perPage)
  const offset = Math.min(Math.max(0, Number(params.get('skip')) || 0), lastOffset)

  const go = (skip: number, per: number) => {
    const next = new URLSearchParams(params)
    if (skip > 0) next.set('skip', String(skip))
    else next.delete('skip')
    if (per !== DEFAULT_PER_PAGE) next.set('per', String(per))
    else next.delete('per')
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  const page = rows.slice(offset, offset + perPage)

  return {
    page,
    offset,
    pager:
      rows.length > perPage ? (
        <Pagination
          count={page.length}
          offset={offset}
          total={rows.length}
          perPage={perPage}
          noun={noun}
          onPrevious={() => go(Math.max(0, offset - perPage), perPage)}
          onNext={() => go(offset + perPage, perPage)}
          onPerPage={(size) => go(0, size)}
        />
      ) : null,
  }
}
