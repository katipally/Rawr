import { LinkButton } from '~/components/link-button.tsx'
import type { MembershipRow } from '@rawr/db'
import { segmentsPath } from '~/lib/links.ts'
import { formatDate } from './value.tsx'

export type SegmentsPanelProps = {
  account: string
  recordName: string
  rows: MembershipRow[]
}

/** Which lists this record is in, and which it used to be in. Past spells are kept
 *  on purpose: somebody asking "why did they stop getting the newsletter" is asking
 *  about an exit, and an exit that leaves no trace cannot answer them. A2. */
export const SegmentsPanel = ({ account, recordName, rows }: SegmentsPanelProps) => {
  const live = rows.filter((row) => row.exitedAt === null)
  const past = rows.filter((row) => row.exitedAt !== null)

  return (
    <section className="rounded-panel border border-line bg-surface shadow-panel">
      <header className="flex items-center justify-between gap-2 px-6 pt-6 pb-4">
        <h2 className="text-base font-semibold">Segments ({live.length})</h2>
        <LinkButton variant="tertiary" href={segmentsPath(account)}>
          Manage
        </LinkButton>
      </header>

      {rows.length === 0 ? (
        <p className="px-6 py-3 text-secondary">
          {recordName} is not in any segment. A segment is a saved query, so membership appears
          here the next time one is recomputed.
        </p>
      ) : (
        <ul className="flex flex-col">
          {live.map((row) => (
            <li
              key={`${row.segmentId}-${row.enteredAt.toISOString()}`}
              className="flex flex-wrap items-baseline justify-between gap-x-2 border-b border-divider px-6 py-1.5 last:border-0"
            >
              <span className="min-w-0 break-words">{row.name}</span>
              <span className="shrink-0 text-small text-secondary">
                since {formatDate(row.enteredAt.toISOString())}
              </span>
            </li>
          ))}
          {past.map((row) => (
            <li
              key={`${row.segmentId}-${row.enteredAt.toISOString()}-past`}
              className="flex flex-wrap items-baseline justify-between gap-x-2 border-b border-divider px-6 py-1.5 text-secondary last:border-0"
            >
              <span className="min-w-0 break-words">{row.name}</span>
              <span className="shrink-0 text-small">
                left {formatDate(row.exitedAt!.toISOString())}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
