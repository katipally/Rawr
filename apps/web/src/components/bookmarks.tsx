'use client'

import { cn } from '@rawr/ui'
import { Bookmark, BookmarkCheck, X } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'

export type BookmarkEntry = { href: string; label: string }

const KEY = 'rawr.bookmarks'

const readAll = (): BookmarkEntry[] => {
  try {
    const raw = window.localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((row): row is BookmarkEntry => typeof row?.href === 'string' && typeof row?.label === 'string')
      : []
  } catch {
    // Private windows and blocked site data are normal, not an error.
    return []
  }
}

/** What the page calls itself: its heading, since the tab title is the app's
 *  name on every screen. */
const titleOf = (): string => document.querySelector('main h1')?.textContent?.trim() || document.title.trim() || 'This page'

/** HubSpot's bookmarks flyout: the pages this person pinned, and a way to pin
 *  the one they are on. Kept in this browser, which is where the rest of the
 *  shell's preferences live. */
export const BookmarksPanel = ({ here }: { here: string }) => {
  const [rows, setRows] = useState<BookmarkEntry[]>([])
  useEffect(() => setRows(readAll()), [here])

  const save = (next: BookmarkEntry[]) => {
    setRows(next)
    try {
      window.localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      // Nothing depends on this surviving the tab.
    }
  }

  const pinned = rows.some((row) => row.href === here)
  const toggle = () => save(pinned ? rows.filter((row) => row.href !== here) : [...rows, { href: here, label: titleOf() }])

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={toggle}
        className="flex min-h-10 items-center gap-2 rounded-pill px-4 py-2 text-left font-light text-nav-text hover:bg-nav-hover"
      >
        {pinned ? <BookmarkCheck aria-hidden="true" className="size-4" /> : <Bookmark aria-hidden="true" className="size-4" />}
        {pinned ? 'Remove this page' : 'Bookmark this page'}
      </button>
      {rows.length > 0 ? <hr className="mx-4 my-3 border-nav-active" /> : null}
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.href} className="flex items-center">
            <Link
              href={row.href}
              aria-current={row.href === here ? 'page' : undefined}
              className={cn(
                'flex min-h-10 min-w-0 flex-1 items-center rounded-pill px-4 py-2 font-light text-nav-text no-underline',
                row.href === here ? 'bg-nav-active' : 'hover:bg-nav-hover',
              )}
            >
              <span className="truncate">{row.label}</span>
            </Link>
            <button
              type="button"
              aria-label={`Remove ${row.label} from bookmarks`}
              onClick={() => save(rows.filter((other) => other.href !== row.href))}
              className="grid size-8 shrink-0 place-items-center rounded-pill text-nav-muted hover:bg-nav-hover hover:text-nav-text"
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
