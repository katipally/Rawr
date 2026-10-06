import { cn } from '@rawr/ui'
import { Check } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'

export const IMPORT_STEPS = ['Type', 'Upload', 'Map', 'Details'] as const

/** HubSpot's 39-tall pills in the wizard's footer, laid over buttonClass. */
export const stepPill = 'min-h-[2.4375rem] px-6 text-[length:var(--rawr-text-body)] font-semibold'

/** HubSpot's full-window import: the title, the four steps and "Step n of 4"
 *  across the top, the step itself in a centred column, and Back, Cancel and
 *  Next along the foot. Every step of Rawr's import renders inside it, whether
 *  it is /import/new or a run that has not started writing yet. */
export const ImportFrame = ({
  step,
  cancelHref,
  back,
  next,
  wide = false,
  children,
}: {
  step: number
  cancelHref: string
  back?: ReactNode
  next?: ReactNode
  /** The mapper and the preview are tables; the first two steps are a form. */
  wide?: boolean
  children: ReactNode
}) => (
  <div className="fixed inset-0 z-overlay flex animate-pop-in flex-col bg-surface text-body motion-reduce:animate-none">
    <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-10">
      <h1 className="font-semibold">Import files</h1>
      <ImportSteps current={step} />
      <p className="ml-auto tabular-nums">
        Step {step + 1} of {IMPORT_STEPS.length}
      </p>
    </header>

    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 sm:px-10">
      <div className={cn('mx-auto flex w-full min-w-0 flex-col gap-6', wide ? 'max-w-6xl' : 'max-w-[37.5rem]')}>
        {children}
      </div>
    </div>

    <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-body px-4 py-4 sm:px-10">
      {back}
      <Link href={cancelHref} className="font-semibold">
        Cancel
      </Link>
      {next ? <span className="ml-auto flex flex-wrap items-center gap-4">{next}</span> : null}
    </footer>
  </div>
)

/** A circle per step joined by a line: finished steps filled with a tick, the
 *  current one a ring, both in HubSpot's orange, and the rest in the body grey.
 *  Below a phone's width the row takes the header's full width on its own line. */
const ImportSteps = ({ current }: { current: number }) => (
  <ol className="order-last flex w-full min-w-0 items-start sm:order-none sm:w-auto sm:flex-1">
    {IMPORT_STEPS.map((label, index) => {
      const done = index < current
      const now = index === current
      return (
        <li
          key={label}
          aria-current={now ? 'step' : undefined}
          className="relative flex min-w-0 flex-1 flex-col items-center gap-1"
        >
          {index > 0 ? (
            <span
              aria-hidden="true"
              className={cn('absolute top-[0.6875rem] right-1/2 h-0.5 w-full', index <= current ? 'bg-step' : 'bg-body')}
            />
          ) : null}
          <span
            aria-hidden="true"
            className={cn(
              'relative flex size-6 items-center justify-center rounded-pill border-2',
              done ? 'border-step bg-step text-white' : now ? 'border-step bg-surface' : 'border-body bg-surface',
            )}
          >
            {done ? <Check className="size-3.5" strokeWidth={3} /> : null}
          </span>
          <span className={cn('max-w-full truncate text-small font-semibold', now && 'text-step')}>
            {label}
            <span className="sr-only">{done ? ', done' : now ? ', current step' : ''}</span>
          </span>
        </li>
      )
    })}
  </ol>
)
