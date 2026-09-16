'use client'

import { cn } from '@rawr/ui'
import { Bookmark, BookmarkCheck, X } from 'lucide-react'
import Link from 'next/link'
import { useUi, useUiReady } from '~/lib/store/ui.ts'

/** What the page calls itself: its heading, since the tab title is the app's
 *  name on every screen. */
const titleOf = (): string => document.querySelector('main h1')?.textContent?.trim() || document.title.trim() || 'This page'

/** HubSpot's bookmarks flyout: the pages this person pinned, and a way to pin
 *  the one they are on. Kept in this browser, in the store the rest of the
 *  shell's preferences live in. */
export const BookmarksPanel = ({ here }: { here: string }) => {
  const rows = useUi((state) => state.bookmarks)
  const toggleBookmark = useUi((state) => state.toggleBookmark)
  const removeBookmark = useUi((state) => state.removeBookmark)
  // Nothing is pinned until the stored list has replaced the empty default, or
  // the panel would render one thing on the server and another here.
  const ready = useUiReady()

  const pinned = ready && rows.some((row) => row.href === here)
  const toggle = () => toggleBookmark({ href: here, label: titleOf() })

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
      {ready && rows.length > 0 ? <hr className="mx-4 my-3 border-nav-active" /> : null}
      <ul className="flex flex-col gap-1">
        {(ready ? rows : []).map((row) => (
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
              onClick={() => removeBookmark(row.href)}
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
