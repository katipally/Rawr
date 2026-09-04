import { AlertTriangle, CircleAlert, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn.ts'

export type AlertTone = 'error' | 'warning' | 'info'

const TONES: Record<AlertTone, { box: string; icon: ReactNode }> = {
  error: {
    box: 'border-error bg-error-subtle text-error',
    icon: <CircleAlert aria-hidden="true" className="size-4 shrink-0" />,
  },
  warning: {
    box: 'border-warning bg-warning-subtle',
    icon: <AlertTriangle aria-hidden="true" className="size-4 shrink-0" />,
  },
  info: {
    box: 'border-line-interactive bg-accent-subtle',
    icon: <Info aria-hidden="true" className="size-4 shrink-0" />,
  },
}

export type AlertProps = {
  tone?: AlertTone
  /** Sits at the end of the line: a retry, a link to the thing that fixes it. */
  action?: ReactNode
  className?: string
  children: ReactNode
}

/** One box for something the person has to know before carrying on.
 *
 *  The same border, background and padding were hand-written on a dozen screens,
 *  which is a dozen chances for one of them to announce itself to a screen reader
 *  and the rest to stay silent. `error` is a live region; the other two are not,
 *  because a notice that was already on the page when it loaded is not news. */
export const Alert = ({ tone = 'error', action, className, children }: AlertProps) => {
  const { box, icon } = TONES[tone]
  return (
    <div
      {...(tone === 'error' ? { role: 'alert' } : {})}
      className={cn('flex flex-wrap items-start gap-2 rounded-hs border px-3 py-2', box, className)}
    >
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
