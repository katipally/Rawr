import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../cn.ts'

type Variant = 'primary' | 'secondary' | 'tertiary' | 'destructive'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-cta text-white hover:bg-cta-hover border-transparent',
  secondary: 'bg-surface text-body border-line hover:bg-fill-hover',
  tertiary: 'bg-transparent text-link border-transparent hover:underline',
  destructive: 'bg-error text-white border-transparent hover:brightness-95',
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  /** Renders the label as a spinner-free disabled state with its own message, so a
   *  slow network is visible rather than silent. */
  busy?: boolean
}

export const Button = ({
  variant = 'secondary',
  busy = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) => (
  <button
    {...rest}
    disabled={disabled || busy}
    aria-busy={busy || undefined}
    className={cn(
      // min-h rather than h: a long label at large text sizes must wrap, not clip.
      'inline-flex min-h-9 items-center justify-center gap-2 rounded-hs border px-3 py-1.5',
      'font-medium transition-colors duration-150',
      'disabled:cursor-not-allowed disabled:opacity-60',
      VARIANTS[variant],
      className,
    )}
  >
    {/* A flex item does not wrap at its min-content width without this, so a long
        label would be clipped instead of running onto a second line. */}
    <span className="min-w-0 break-words">{children}</span>
  </button>
)
