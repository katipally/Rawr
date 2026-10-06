import type { ReactNode } from 'react'
import { FILTERS_DOCK } from '~/lib/docks.ts'

/** Everything under a list's tabs, with room on the right for the advanced
 *  filters panel, which the toolbar portals in. The content gives up the width
 *  the panel takes. */
export const FiltersDock = ({ children }: { children: ReactNode }) => (
  <div className="relative flex min-h-0 flex-1">
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">{children}</div>
    <div id={FILTERS_DOCK} className="contents" />
  </div>
)
