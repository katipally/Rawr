import type { ButtonHTMLAttributes } from 'react'
import { cn } from '../cn.ts'

type Variant = 'primary' | 'secondary' | 'tertiary' | 'destructive'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-cta text-white hover:bg-cta-hover border-cta hover:border-cta-hover',
  secondary: 'bg-surface text-body border-line-strong hover:bg-fill-hover',
  tertiary: 'bg-transparent text-link border-transparent hover:underline',
  // Outlined, not filled. Twenty of the twenty-three destructive buttons are
  // per-row triggers, and filling them made a stack of ten Delete buttons the
  // loudest thing on a settings page. Red on the border and the text is enough
  // to read as dangerous, in a row and in a confirmation dialog alike.
  destructive: 'bg-transparent text-error border-error hover:bg-error-subtle',
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
      'inline-flex min-h-control items-center justify-center gap-2 rounded-pill border px-4 py-2',
      'text-small font-light leading-none transition-colors duration-150',
      // A faded coral primary reads as broken rather than as not-yet-available.
      // Every filled button drops to the neutral fill when disabled, so "nothing
      // to save yet" and "this is dead" never look alike. A tertiary button is a
      // link, and a disabled link fades; boxing it would invent a control.
      'disabled:cursor-not-allowed',
      variant === 'tertiary'
        ? 'disabled:text-secondary disabled:no-underline disabled:opacity-60'
        : 'disabled:border-line disabled:bg-disabled disabled:text-secondary',
      VARIANTS[variant],
      className,
    )}
  >
    {/* A flex item does not wrap at its min-content width without this, so a long
        label would be clipped instead of running onto a second line. */}
    <span className="min-w-0 break-words">{children}</span>
  </button>
)
