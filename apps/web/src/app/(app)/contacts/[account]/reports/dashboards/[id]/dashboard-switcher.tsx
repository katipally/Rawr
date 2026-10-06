'use client'

import { cn, Popover } from '@rawr/ui'
import { Check, ChevronDown, Search } from 'lucide-react'
import Link from 'next/link'
import { useRef, useState } from 'react'
import { dashboardPath } from '~/lib/links.ts'
import { matching } from '../../library.tsx'

export type SwitchChoice = { id: string; name: string; mine: boolean }

/** HubSpot's dashboard name: the heading is the button, and it opens every
 *  dashboard this person can see, All or only their own, with a search. */
export const DashboardSwitcher = ({
  account,
  from,
  to,
  current,
  all,
}: {
  account: string
  from: string
  to: string
  current: { id: string; name: string }
  all: SwitchChoice[]
}) => {
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [mineOnly, setMineOnly] = useState(false)
  const [q, setQ] = useState('')
  const shown = matching(mineOnly ? all.filter((row) => row.mine) : all, q)

  return (
    <>
      <button
        ref={button}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-w-0 items-center gap-2 rounded-hs text-left transition-all duration-150 ease-out hover:text-secondary"
      >
        <h1 className="min-w-0 truncate text-2xl font-semibold">{current.name}</h1>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={button}
        align="start"
        label="Switch dashboard"
        className="flex w-[min(34.4375rem,calc(100vw-2rem))] flex-col overflow-hidden"
      >
        <div role="tablist" aria-label="Which dashboards" className="flex border-b border-line">
          {[
            { key: false, label: 'All' },
            { key: true, label: 'My dashboards' },
          ].map((tab) => (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={mineOnly === tab.key}
              onClick={() => setMineOnly(tab.key)}
              className={cn(
                'min-w-0 flex-1 border-b-4 px-4 py-3 transition-all duration-150 ease-out hover:bg-fill',
                mineOnly === tab.key ? 'border-body' : 'border-transparent',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <label className="relative m-3 min-w-0">
          <span className="sr-only">Search dashboards</span>
          <input
            type="search"
            value={q}
            placeholder="Search dashboards"
            onChange={(event) => setQ(event.target.value)}
            className="h-10 w-full rounded-pill border border-line-strong bg-surface py-2 pr-10 pl-4 text-base font-light placeholder:text-muted"
          />
          <Search aria-hidden="true" className="absolute top-1/2 right-4 size-4 -translate-y-1/2" />
        </label>
        <ul className="min-h-0 overflow-y-auto pb-2">
          {shown.length === 0 ? (
            <li className="px-5 py-2 text-secondary">No dashboards match.</li>
          ) : (
            shown.map((row) => (
              <li key={row.id}>
                <Link
                  href={dashboardPath(account, row.id, { from, to })}
                  aria-current={row.id === current.id ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                  className="flex min-h-10 items-center gap-2 px-5 py-2 font-normal text-body no-underline transition-all duration-150 ease-out hover:bg-fill"
                >
                  <span className="min-w-0 flex-1 break-words">{row.name}</span>
                  {row.id === current.id ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
                </Link>
              </li>
            ))
          )}
        </ul>
      </Popover>
    </>
  )
}
