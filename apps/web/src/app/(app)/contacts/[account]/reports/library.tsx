'use client'

import { cn } from '@rawr/ui'
import { Search } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { reportsPath } from '~/lib/links.ts'
import { useUrlParam } from '~/lib/url-params.ts'

/** HubSpot's reports list frame: a search and the Dashboards and Reports links
 *  down the left, the table of whichever is open beside them. The search is the
 *  address's `q`, so it carries from one list to the other. */
export const ReportsLibrary = ({
  account,
  from,
  to,
  current,
  counts,
  title,
  action,
  children,
}: {
  account: string
  from: string
  to: string
  current: 'dashboards' | 'list'
  counts: { dashboards: number; reports: number }
  title: string
  action?: ReactNode
  children: ReactNode
}) => {
  const [q, setQ] = useUrlParam('q')
  const links = [
    { key: 'dashboards' as const, label: 'Dashboards', count: counts.dashboards },
    { key: 'list' as const, label: 'Reports', count: counts.reports },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-6 @4xl:flex-row">
      <nav aria-label="Reports library" className="flex w-full min-w-0 shrink-0 flex-col gap-4 @4xl:w-[15.625rem]">
        <label className="relative min-w-0">
          <span className="sr-only">Search dashboards and reports</span>
          <input
            type="search"
            value={q ?? ''}
            placeholder="Search"
            onChange={(event) => setQ(event.target.value || null)}
            className="h-10 w-full rounded-pill border border-line-strong bg-surface py-2 pr-10 pl-4 text-base font-light placeholder:text-muted"
          />
          <Search aria-hidden="true" className="absolute top-1/2 right-4 size-4 -translate-y-1/2" />
        </label>
        <ul className="flex flex-col">
          {links.map((link) => (
            <li key={link.key}>
              <Link
                href={reportsPath(account, { tab: link.key, from, to, q: q ?? undefined })}
                aria-current={current === link.key ? 'page' : undefined}
                className={cn(
                  'flex h-10 items-center justify-between gap-2 rounded-hs px-3 font-light text-body no-underline transition-all duration-150 ease-out hover:bg-fill',
                  current === link.key && 'bg-canvas hover:bg-canvas',
                )}
              >
                <span className="min-w-0 truncate">{link.label}</span>
                <span className="shrink-0 tabular-nums">{link.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <section aria-label={title} className="flex min-w-0 flex-1 flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <h2 className="min-w-0 text-[1.375rem] font-medium">{title}</h2>
          {action}
        </div>
        {children}
      </section>
    </div>
  )
}

/** The rows whose name holds the search, ignoring case. O(rows). */
export const matching = <Row extends { name: string }>(rows: Row[], q: string | null): Row[] => {
  const needle = q?.trim().toLowerCase()
  return needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows
}
