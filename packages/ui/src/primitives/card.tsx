'use client'

import { ChevronDown, ChevronRight } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { cn } from '../cn.ts'

export type CardProps = {
  title?: ReactNode
  /** Sits at the right of the header: a count, a Badge, an Add button. */
  action?: ReactNode
  /** Makes the header a disclosure button. Open state is local; a card that must
   *  remember belongs in the URL, not here. */
  collapsible?: boolean
  defaultOpen?: boolean
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
  flush = false,
  className,
  children,
}: CardProps) => {
  const id = useId()
  const [open, setOpen] = useState(defaultOpen)
  const showing = collapsible ? open : true

  return (
    <section className={cn('rounded-panel border border-line bg-surface shadow-panel', className)}>
      {title || action ? (
        <header className="flex items-center justify-between gap-2 border-b border-divider px-4 py-2.5">
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              onClick={() => setOpen((value) => !value)}
              className="flex min-w-0 items-center gap-1.5 rounded-hs font-medium hover:text-link"
            >
              {open ? (
                <ChevronDown aria-hidden="true" className="size-4 shrink-0 text-secondary" />
              ) : (
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-secondary" />
              )}
              <span className="min-w-0 truncate">{title}</span>
            </button>
          ) : (
            <h2 className="min-w-0 truncate font-medium">{title}</h2>
          )}
          {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
        </header>
      ) : null}
      {showing ? (
        <div id={id} className={cn(flush ? '' : 'p-4')}>
          {children}
        </div>
      ) : null}
    </section>
  )
}
