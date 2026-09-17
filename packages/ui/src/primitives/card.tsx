'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { cn } from '../cn.ts'

export type CardProps = {
  title?: ReactNode
  /** Sits at the right of the header: a count, a Badge, an Add button. */
  action?: ReactNode
  /** Makes the header a disclosure button. Open state is local by default; pass
   *  `open`/`onOpenChange` to have a caller remember it somewhere that outlives
   *  this page (a URL, a preference) instead. */
  collapsible?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Removes the body padding, for a card whose content is a table. */
  flush?: boolean
  className?: string
  children: ReactNode
}

/** The panel every surface is built from: a bordered white box with an optional
 *  header. HubSpot's record page is a column of these, and so is ours. */
export const Card = ({
  title,
  action,
  collapsible = false,
  defaultOpen = true,
  open: openProp,
  onOpenChange,
  flush = false,
  className,
  children,
}: CardProps) => {
  const id = useId()
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const open = openProp ?? localOpen
  const setOpen = (value: boolean) => {
    if (openProp === undefined) setLocalOpen(value)
    onOpenChange?.(value)
  }
  const showing = collapsible ? open : true

  return (
    <section className={cn('@container rounded-panel border border-line bg-surface shadow-panel', className)}>
      {title || action ? (
        <header className={cn('flex items-center justify-between gap-2 px-6 pt-6', showing ? 'pb-4' : 'pb-6')}>
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen(!open)}
              className="flex min-w-0 items-center gap-2 rounded-hs text-base font-semibold"
            >
              {open ? (
                <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
              ) : (
                <ChevronRight aria-hidden="true" className="size-4 shrink-0" />
              )}
              <span className="min-w-0 truncate">{title}</span>
            </button>
          ) : (
            <h2 className="min-w-0 truncate text-base font-semibold">{title}</h2>
          )}
          {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
        </header>
      ) : null}
      {showing ? (
        <div id={id} className={cn(flush ? '' : title || action ? 'px-6 pb-6' : 'p-6')}>
          {children}
        </div>
      ) : null}
    </section>
  )
}
