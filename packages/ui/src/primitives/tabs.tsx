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
  <nav aria-label={label} className={cn('flex min-w-0 gap-1 overflow-x-auto', className)}>
    {items.map((item) => (
      <a
        key={item.key}
        href={item.href}
        aria-current={item.current ? 'page' : undefined}
        className={cn(
          'flex min-h-control shrink-0 items-center gap-1.5 rounded-hs px-3 py-1 font-normal no-underline',
          item.current ? 'bg-fill-hover text-body' : 'text-secondary hover:bg-fill hover:text-body',
        )}
      >
        <span className="truncate">{item.label}</span>
        {item.hint ? <span className="shrink-0 text-small text-secondary">{item.hint}</span> : null}
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
