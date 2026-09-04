'use client'

import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { cn } from '../cn.ts'
import { Tooltip } from './tooltip.tsx'
import type { Side } from './position.ts'

type Tone = 'default' | 'accent' | 'destructive'

const TONES: Record<Tone, string> = {
  default: 'text-secondary hover:bg-fill-hover hover:text-body',
  accent: 'bg-accent-subtle text-link',
  destructive: 'text-error hover:bg-error-subtle',
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  /** Required: it is the accessible name and the tooltip, because an icon alone
   *  says nothing to a screen reader and little to a new person. */
  label: string
  icon: ReactNode
  tone?: Tone
  side?: Side
  /** React 19 passes refs as a plain prop, and the menu and the popover both
   *  need the button they hang off. */
  ref?: Ref<HTMLButtonElement>
}

/** An icon-only control that cannot exist without a name. Every bare icon button
 *  in the app goes through here, so none of them can be silently unlabelled. */
export const IconButton = ({
  label,
  icon,
  tone = 'default',
  side = 'bottom',
  className,
  ref,
  ...rest
}: IconButtonProps) => (
  <Tooltip label={label} side={side}>
    <button
      {...rest}
      ref={ref}
      type={rest.type ?? 'button'}
      aria-label={label}
      className={cn(
        'inline-flex size-8 shrink-0 items-center justify-center rounded-hs transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:text-secondary disabled:opacity-60 disabled:hover:bg-transparent',
        TONES[tone],
        className,
      )}
    >
      {icon}
    </button>
  </Tooltip>
)
