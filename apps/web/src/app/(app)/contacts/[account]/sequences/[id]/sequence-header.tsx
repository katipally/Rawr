import type { SequenceState } from '@rawr/db'
import { cn } from '@rawr/ui'
import { ChevronLeft } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { StatusDot, type StatusTone } from '~/components/row-actions.tsx'
import { enrollmentsPath, sequencePath, sequenceSendsPath, sequencesPath } from '~/lib/links.ts'

export type SequenceTab = 'steps' | 'enrollments' | 'sends'

const TONE: Record<SequenceState, StatusTone> = { draft: 'off', active: 'live', paused: 'pending', archived: 'archived' }
const LABEL: Record<SequenceState, string> = { draft: 'Draft', active: 'Active', paused: 'Paused', archived: 'Archived' }

/** HubSpot's sequence header, shared by the steps, who is in it and what it
 *  sent so the three read as one sequence's tabs: back link, name, state, the
 *  sequence's own buttons, and the tabs. */
export const SequenceHeader = ({
  account,
  sequence,
  current,
  actions,
}: {
  account: string
  sequence: { id: string; name: string; state: SequenceState; description: string | null }
  current: SequenceTab
  actions?: ReactNode
}) => {
  const tabs: { key: SequenceTab; label: string; href: string }[] = [
    { key: 'steps', label: 'Steps', href: sequencePath(account, sequence.id) },
    { key: 'enrollments', label: 'Enrollments', href: enrollmentsPath(account, sequence.id) },
    { key: 'sends', label: 'Emails sent', href: sequenceSendsPath(account, sequence.id) },
  ]
  return (
    <header className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Link
            href={sequencesPath(account)}
            className="inline-flex items-center gap-0.5 self-start text-small font-semibold text-body no-underline hover:underline"
          >
            <ChevronLeft aria-hidden="true" className="size-3.5" />
            Back to sequences
          </Link>
          <h1 className="min-w-0 break-words text-xl font-medium">{sequence.name}</h1>
          <span className="flex min-w-0 text-small">
            <StatusDot tone={TONE[sequence.state]}>{LABEL[sequence.state]}</StatusDot>
          </span>
          {sequence.description ? <p className="break-words text-secondary">{sequence.description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <nav aria-label="Sequence" className="scroll-fade-x flex min-w-0 overflow-x-auto border-b border-line">
        {tabs.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            aria-current={tab.key === current ? 'page' : undefined}
            className={cn(
              'relative flex h-12 shrink-0 items-center rounded-hs px-7 whitespace-nowrap text-body no-underline transition-colors duration-150 ease-out hover:bg-fill',
              tab.key === current
                ? 'font-medium after:absolute after:inset-x-3 after:bottom-0 after:h-1 after:rounded-[24px] after:bg-body'
                : 'font-normal',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
    </header>
  )
}
