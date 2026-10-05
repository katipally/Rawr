'use client'

import { useEffect, useRef } from 'react'

/** What the record on screen just gained, announced by whatever added it so the
 *  panels that list it can read it again. The alternative is refreshing the page,
 *  which renders every panel on a record to update one of them. */
export type RecordChange = 'timeline' | 'tasks'

const EVENT = 'rawr:record-changed'

export const announceChange = (change: RecordChange): void => {
  window.dispatchEvent(new CustomEvent<RecordChange>(EVENT, { detail: change }))
}

export const useOnChange = (change: RecordChange, onChange: () => void): void => {
  // Read through a ref so a handler rebuilt every render does not resubscribe.
  const latest = useRef(onChange)
  latest.current = onChange
  useEffect(() => {
    const listen = (event: Event) => {
      if ((event as CustomEvent<RecordChange>).detail === change) latest.current()
    }
    window.addEventListener(EVENT, listen)
    return () => window.removeEventListener(EVENT, listen)
  }, [change])
}
