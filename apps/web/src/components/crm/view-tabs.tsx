'use client'

import { cn } from '@rawr/ui'
import Link from 'next/link'
import type { ObjectKey } from '@rawr/db'
import { objectView, type ListParams } from '~/lib/links.ts'

export type ViewTab = { slug: string; name: string; kind: 'table' | 'board'; isShared: boolean }

export type ViewTabsProps = {
  workspace: string
  object: ObjectKey
  views: ViewTab[]
  current: string
  currentKind: 'list' | 'board'
  /** Carried onto every tab so switching views keeps the search a person typed. */
  params: ListParams
}

/** Switching tabs starts the list again, so the page cursor is dropped rather
 *  than carried onto a different result set. */
const withoutCursor = (params: ListParams): ListParams => {
  const next = { ...params }
  delete next.cursor
  return next
}

/** HubSpot's view tabs. The slug is the address, so a tab is a link, not state:
 *  right-click and copy gives someone else exactly this screen. */
export const ViewTabs = ({ workspace, object, views, current, currentKind, params }: ViewTabsProps) => (
  <div className="flex flex-wrap items-end gap-x-1 gap-y-1 border-b border-divider">
    {views.map((view) => {
      const active = view.slug === current
      return (
        <Link
          key={view.slug}
          href={objectView(workspace, object, view.slug, currentKind, withoutCursor(params))}
          aria-current={active ? 'page' : undefined}
          className={cn(
            '-mb-px border-b-2 px-3 py-1.5 font-medium no-underline',
            active ? 'border-accent text-link' : 'border-transparent text-secondary hover:text-body',
          )}
        >
          {view.name}
          {view.isShared ? null : <span className="ml-1 text-small text-secondary">(mine)</span>}
        </Link>
      )
    })}

    {object === 'deal' ? (
      <span className="ml-auto flex gap-1 pb-1">
        {(['list', 'board'] as const).map((kind) => (
          <Link
            key={kind}
            href={objectView(workspace, object, current, kind, withoutCursor(params))}
            aria-current={currentKind === kind ? 'true' : undefined}
            className={cn(
              'rounded-hs border px-2 py-1 no-underline',
              currentKind === kind ? 'border-line-interactive bg-accent-subtle text-link' : 'border-line text-secondary',
            )}
          >
            {kind === 'list' ? 'Table' : 'Board'}
          </Link>
        ))}
      </span>
    ) : null}
  </div>
)
