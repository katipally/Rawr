'use client'

import { useRef } from 'react'

/** Stable keys for a list of rows whose every field is editable.
 *
 *  A key taken from the row's own data is a key that changes as somebody types
 *  into it: React treats the row as a different row, unmounts the input, mounts a
 *  fresh one, and the caret is gone after the first character. That is what made
 *  the form builder's Key field and the booking page's Stored as field impossible
 *  to type into.
 *
 *  So the key is minted here instead, in the browser, and never leaves it: it is
 *  not part of the row and nothing saves it. The list of ids is kept in step with
 *  the rows by the same handlers that add, remove and reorder them; a list the
 *  caller replaced wholesale is spotted by its length and re-minted. */

let counter = 0
const mint = (): string => {
  counter += 1
  return `row-${counter}`
}

export type RowIds = {
  at: (index: number) => string
  added: () => void
  removed: (index: number) => void
  moved: (index: number, by: number) => void
}

export const useRowIds = (length: number): RowIds => {
  const ids = useRef<string[]>([])
  if (ids.current.length !== length) {
    ids.current = Array.from({ length }, (_, index) => ids.current[index] ?? mint())
  }

  return {
    at: (index) => ids.current[index] ?? `row-${index}`,
    added: () => {
      ids.current = [...ids.current, mint()]
    },
    removed: (index) => {
      ids.current = ids.current.filter((_, at) => at !== index)
    },
    moved: (index, by) => {
      const next = [...ids.current]
      const [moved] = next.splice(index, 1)
      if (moved) next.splice(index + by, 0, moved)
      ids.current = next
    },
  }
}
