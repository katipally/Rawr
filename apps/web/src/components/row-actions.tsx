import { cn } from '@rawr/ui'
import type { ReactNode } from 'react'

/** HubSpot's hover pills on its segment, form and email lists: 23 tall, 12px
 *  light, outlined in the control grey. */
export const rowPill =
  'inline-flex h-[1.4375rem] shrink-0 items-center gap-1 rounded-pill border border-line-strong bg-surface px-3 text-small font-light whitespace-nowrap text-body no-underline transition-all duration-150 ease-out hover:bg-fill disabled:cursor-not-allowed disabled:text-muted'

/** The pills after a row's name. Shown with the row under the pointer or a pill
 *  focused, and always on a device with no hover to show them with. Hidden they
 *  take no width, so the name only gives up room while they are out; squeezed to
 *  nothing rather than removed, so Tab still reaches them. */
export const RowActions = ({ children, className }: { children: ReactNode; className?: string }) => (
  <span
    className={cn(
      'flex max-w-0 shrink-0 items-center gap-1 overflow-hidden opacity-0',
      'focus-within:max-w-none focus-within:overflow-visible focus-within:opacity-100',
      '[tr:hover_&]:max-w-none [tr:hover_&]:overflow-visible [tr:hover_&]:opacity-100',
      '[@media(hover:none)]:max-w-none [@media(hover:none)]:opacity-100',
      className,
    )}
  >
    {children}
  </span>
)

export type StatusTone = 'live' | 'pending' | 'off' | 'archived'

const DOT: Record<StatusTone, string> = {
  live: 'bg-status-live',
  pending: 'bg-status-pending',
  off: 'bg-line-strong',
  archived: 'border-2 border-line-strong',
}

/** A state as a 10px dot before its word. The word always carries it too. */
export const StatusDot = ({ tone, children }: { tone: StatusTone; children?: ReactNode }) => (
  <span className="inline-flex min-w-0 items-center gap-2">
    <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-pill', DOT[tone])} />
    <span className="min-w-0 truncate">{children}</span>
  </span>
)
