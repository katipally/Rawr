import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../cn.ts'

export type TabItem = {
  key: string
  label: ReactNode
  href: string
  /** A count or a Badge shown after the label. */
  hint?: ReactNode
  current?: boolean
}

export type TabsProps = {
  label: string
  items: TabItem[]
  className?: string
}

/** Address-driven tabs: each one is a link, so a tab is shareable, survives a
 *  reload and works with the back button. Nothing here holds state. */
export const Tabs = ({ label, items, className }: TabsProps) => (
  <nav
    aria-label={label}
    className={cn('flex min-w-0 overflow-x-auto rounded-t-hs border-b border-line', className)}
  >
    {items.map((item) => (
      <a
        key={item.key}
        href={item.href}
        aria-current={item.current ? 'page' : undefined}
        className={cn(
          'flex h-12 shrink-0 items-center gap-1.5 border-r border-line px-7 text-body no-underline last:border-r-0',
          item.current ? 'bg-surface font-medium' : 'bg-fill font-normal hover:bg-fill-hover',
        )}
      >
        <span className="truncate">{item.label}</span>
        {item.hint ? <span className="shrink-0 text-small text-secondary">{item.hint}</span> : null}
      </a>
    ))}
  </nav>
)

export type FilterRowProps = {
  label: string
  items: TabItem[]
  /** Named in front of the row when the choices alone do not say what is being
   *  chosen: "Group by", "Looking at". */
  lead?: ReactNode
  className?: string
}

/** A row of choices that narrows what the page already shows, as against `Tabs`,
 *  which moves between screens. Both are links, for the same reason.
 *
 *  The distinction is worth a second component because it was already being drawn
 *  five different ways by hand -- pills here, soft chips in Meetings, an icon row
 *  on Tasks, an underline on Submissions -- and a person cannot learn a control
 *  that looks different on every screen. */
export const FilterRow = ({ label, items, lead, className }: FilterRowProps) => (
  <nav aria-label={label} className={cn('flex flex-wrap items-center gap-1', className)}>
    {lead ? <span className="text-small text-secondary">{lead}</span> : null}
    {items.map((item) => (
      <a
        key={item.key}
        href={item.href}
        aria-current={item.current ? 'page' : undefined}
        className={cn(
          'inline-flex h-control shrink-0 items-center gap-1.5 rounded-pill border border-line-strong px-4',
          'text-small font-light text-body no-underline',
          item.current ? 'bg-fill-hover' : 'bg-surface hover:bg-fill',
        )}
      >
        <span className="truncate">{item.label}</span>
        {item.hint ? <span className="shrink-0 text-secondary">{item.hint}</span> : null}
      </a>
    ))}
  </nav>
)

export type Crumb = { label: string; href?: string }

/** Where this record sits. The last crumb is the page itself and is never a
 *  link, which is what tells a screen reader it has arrived. */
export const Breadcrumb = ({ items }: { items: Crumb[] }) => (
  <nav aria-label="Breadcrumb">
    <ol className="flex min-w-0 flex-wrap items-center gap-1 text-small text-secondary">
      {items.map((item, index) => (
        <li key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-1">
          {index > 0 ? <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" /> : null}
          {item.href && index < items.length - 1 ? (
            <a href={item.href} className="truncate no-underline hover:underline">
              {item.label}
            </a>
          ) : (
            <span aria-current={index === items.length - 1 ? 'page' : undefined} className="truncate">
              {item.label}
            </span>
          )}
        </li>
      ))}
    </ol>
  </nav>
)
