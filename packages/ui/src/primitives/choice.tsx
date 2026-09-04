'use client'

import { Check, Minus } from 'lucide-react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import { cn } from '../cn.ts'

type BaseProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> & {
  label: ReactNode
  /** A second line under the label. */
  hint?: ReactNode
  /** Label for screen readers only, for a checkbox in a table header cell. */
  hideLabel?: boolean
}

export type CheckboxProps = BaseProps & {
  /** Neither on nor off: some of the rows below are selected. */
  indeterminate?: boolean
}

/** A real input under a drawn box, so the browser keeps the focus ring, the
 *  keyboard behaviour and form participation, and we only own the paint. */
export const Checkbox = ({ label, hint, hideLabel, indeterminate, className, ...rest }: CheckboxProps) => (
  <label className={cn('flex min-w-0 cursor-pointer items-start gap-2', rest.disabled && 'cursor-not-allowed opacity-60', className)}>
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      <input
        {...rest}
        type="checkbox"
        ref={(node) => {
          if (node) node.indeterminate = indeterminate ?? false
        }}
        className="peer size-4 appearance-none rounded-[2px] border border-line bg-surface checked:border-accent checked:bg-accent indeterminate:border-accent indeterminate:bg-accent disabled:bg-disabled"
      />
      {indeterminate ? (
        <Minus aria-hidden="true" className="pointer-events-none absolute size-3 text-white" />
      ) : (
        <Check aria-hidden="true" className="pointer-events-none absolute hidden size-3 text-white peer-checked:block" />
      )}
    </span>
    <span className={cn('min-w-0', hideLabel && 'sr-only')}>
      <span className="block">{label}</span>
      {hint ? <span className="block text-small text-secondary">{hint}</span> : null}
    </span>
  </label>
)

/** A checkbox that reads as on or off rather than as ticked. Same input
 *  underneath, because a switch is a checkbox with a different paint, and the
 *  native checked state is what a screen reader announces: adding role="switch"
 *  on top would mean owning aria-checked by hand for no gain. */
export const Switch = ({ label, hint, hideLabel, className, ...rest }: BaseProps) => (
  <label className={cn('flex min-w-0 cursor-pointer items-start gap-2', rest.disabled && 'cursor-not-allowed opacity-60', className)}>
    <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
      <input
        {...rest}
        type="checkbox"
        className="peer size-full appearance-none rounded-full border border-line bg-fill-hover transition-colors duration-150 checked:border-accent checked:bg-accent disabled:bg-disabled"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0.5 size-4 rounded-full bg-surface shadow-panel transition-transform duration-150 peer-checked:translate-x-4"
      />
    </span>
    <span className={cn('min-w-0', hideLabel && 'sr-only')}>
      <span className="block">{label}</span>
      {hint ? <span className="block text-small text-secondary">{hint}</span> : null}
    </span>
  </label>
)
