import type { ReactNode } from 'react'

/** B7. Six reports behind one frame. The header is rendered by each page rather
 *  than here, because only a page is given the query string the range lives in. */
const ReportsLayout = ({ children }: { children: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-4">{children}</div>
)

export default ReportsLayout
