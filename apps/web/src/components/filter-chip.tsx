'use client'

import { Popover, TextInput, cn } from '@rawr/ui'
import { Check, ChevronDown, X } from 'lucide-react'
import Link from 'next/link'
import { useRef, useState } from 'react'

export type FilterOption = { key: string; label: string; href: string; on: boolean }

/** HubSpot's ghost filter button: 12/600, no border until it is set. */
export const ghostFilter =
  'inline-flex h-pill min-w-0 items-center gap-1 rounded-pill px-2 text-small font-semibold text-body transition-all duration-150 ease-out hover:bg-fill'
/** Past this many options a list gets a search box. */
const SEARCH_FROM = 8

/** One quick filter: a ghost button while it is unset, a grey chip with its own
 *  clear while it is set, and a list that applies on the click. */
export const FilterChip = ({ label, options, clear }: { label: string; options: FilterOption[]; clear: string }) => {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const picked = options.find((option) => option.on)
  const needle = query.trim().toLowerCase()
  const visible = needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options
  const text = picked ? `${label}: ${picked.label}` : label

  return (
    <span className={cn('inline-flex min-w-0 items-center rounded-pill', picked && 'bg-fill-hover')}>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={text}
        onClick={() => {
          setQuery('')
          setOpen((shown) => !shown)
        }}
        className={ghostFilter}
      >
        <span className="max-w-64 truncate">{text}</span>
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
      </button>
      {picked ? (
        <Link href={clear} aria-label={`Clear ${label}`} className="mr-1 grid size-6 shrink-0 place-items-center rounded-pill text-body no-underline hover:bg-fill">
          <X aria-hidden="true" className="size-3.5" />
        </Link>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="start" label={label}>
        <div className="flex w-[min(18rem,calc(100vw-2rem))] flex-col gap-2 p-3">
          {options.length > SEARCH_FROM ? (
            <TextInput
              aria-label={`Search ${label}`}
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-control min-h-0 rounded-pill"
            />
          ) : null}
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {visible.map((option) => (
              <li key={option.key}>
                <Link
                  href={option.href}
                  aria-current={option.on ? 'true' : undefined}
                  onClick={() => setOpen(false)}
                  className="flex min-w-0 items-center gap-2 rounded-hs px-3 py-2 font-normal text-body no-underline hover:bg-fill"
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.on ? <Check aria-hidden="true" className="size-4 shrink-0" /> : null}
                </Link>
              </li>
            ))}
            {visible.length === 0 ? <li className="px-3 py-2 text-secondary">Nothing matches.</li> : null}
          </ul>
        </div>
      </Popover>
    </span>
  )
}
