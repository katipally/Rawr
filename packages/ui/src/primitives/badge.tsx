import type { ReactNode } from 'react'
import { cn } from '../cn.ts'

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'error' | 'info' | 'accent'

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-fill text-secondary border-line',
  ok: 'bg-success-subtle text-success border-success/30',
  warn: 'bg-warning-subtle text-warning border-warning/30',
  error: 'bg-error-subtle text-error border-error/30',
  info: 'bg-info-subtle text-info border-info/30',
  accent: 'bg-accent-subtle text-accent border-accent/30',
}

export type BadgeProps = {
  tone?: BadgeTone
  /** A leading dot for status. Cheaper to scan down a column than a whole fill. */
  dot?: boolean
  className?: string
  children: ReactNode
}

/** A short state label: a stage, a health, a count. Colour is never the only
 *  carrier, the word always is, so it survives a colour-blind reader and a
 *  greyscale print alike. */
export const Badge = ({ tone = 'neutral', dot = false, className, children }: BadgeProps) => (
  <span
    className={cn(
      'inline-flex max-w-full items-center gap-1.5 rounded-hs border px-1.5 py-0.5 text-small font-medium',
      TONES[tone],
      className,
    )}
  >
    {dot ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" /> : null}
    <span className="min-w-0 truncate">{children}</span>
  </span>
)
