'use client'

import { HelpCircle } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { cn } from '../cn.ts'
import { IconButton } from './icon-button.tsx'
import { Popover } from './popover.tsx'

export type PageHeaderProps = {
  title: string
  /** One short line: what this screen is, in the words somebody would use to ask
   *  for it. Not why it works the way it does. */
  lead?: ReactNode
  /** Why it works the way it does. Lives behind a question mark, because it is
   *  worth reading once and worth nothing on the fourteenth visit. */
  why?: ReactNode
  /** Sits at the right of the title row: the primary action for the screen. */
  action?: ReactNode
  /** `h1` for a page, `h2` for a settings tab that already sits under one. */
  as?: 'h1' | 'h2'
  className?: string
}

/** The top of every screen.
 *
 *  Before this each page hand-rolled a heading and a two-to-four sentence
 *  paragraph explaining its own design, and every one of them was on screen
 *  permanently. The rationale was worth writing and is not worth re-reading, so
 *  it moved one click away rather than being deleted: `lead` is what you see,
 *  `why` is what you ask for. */
export const PageHeader = ({ title, lead, why, action, as = 'h1', className }: PageHeaderProps) => {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const Heading = as

  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-1">
          <Heading className={as === 'h1' ? 'text-lg font-medium' : 'text-base font-medium'}>{title}</Heading>
          {why ? (
            <>
              <IconButton
                ref={trigger}
                label={`Why ${title} works this way`}
                aria-expanded={open}
                icon={<HelpCircle aria-hidden="true" className="size-4" />}
                onClick={() => setOpen((value) => !value)}
              />
              <Popover
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={trigger}
                align="start"
                label={`Why ${title} works this way`}
                className="max-w-prose p-3"
              >
                <div className="flex flex-col gap-2 text-secondary">{why}</div>
              </Popover>
            </>
          ) : null}
        </div>
        {lead ? <p className="max-w-prose text-secondary">{lead}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
    </div>
  )
}
