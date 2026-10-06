'use client'

import { EmptyState, NOTHING_MATCHED } from '@rawr/ui'
import { Search } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import type { IntegrationKind } from '@rawr/db'
import { AppLogo } from '~/components/app-logo.tsx'
import { appPath } from '~/lib/links.ts'

export type AvailableApp = {
  kind: IntegrationKind
  name: string
  category: string
  appType: 'Shared' | 'Personal'
  purpose: string
}

/** HubSpot's marketplace rows: a heading per category and a card per app, each
 *  card a link to the app's own page where connecting happens. Search narrows
 *  every row at once; a category with nothing left disappears rather than
 *  showing an empty shelf. */
export const AvailableGrid = ({ apps }: { apps: AvailableApp[] }) => {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const matching = apps.filter(
    (app) =>
      needle === '' ||
      app.name.toLowerCase().includes(needle) ||
      app.category.toLowerCase().includes(needle) ||
      app.purpose.toLowerCase().includes(needle),
  )

  // Insertion order is the registry's order, so categories read in the order
  // the providers were declared rather than alphabetically.
  const byCategory = new Map<string, AvailableApp[]>()
  for (const app of matching) byCategory.set(app.category, [...(byCategory.get(app.category) ?? []), app])

  return (
    <div className="flex flex-col gap-6">
      <label className="relative w-full min-w-0 @lg:w-[25rem]">
        <span className="sr-only">Search apps</span>
        <input
          type="search"
          value={query}
          placeholder="Search apps"
          onChange={(event) => setQuery(event.target.value)}
          className="h-10 w-full rounded-pill border border-line-strong bg-surface py-2 pr-10 pl-4 text-body placeholder:text-muted"
        />
        <Search aria-hidden="true" className="absolute top-1/2 right-4 size-4 -translate-y-1/2" />
      </label>

      {byCategory.size === 0 ? (
        <EmptyState {...NOTHING_MATCHED} />
      ) : (
        [...byCategory].map(([category, list]) => (
          <section key={category} className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{category}</h2>
            <ul className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4">
              {list.map((app) => (
                <li key={app.kind} className="min-w-0">
                  <Link
                    href={appPath(app.kind)}
                    className="flex h-full flex-col gap-3 rounded-panel border border-line bg-surface p-5 text-body no-underline shadow-panel transition-shadow duration-150 ease-out hover:shadow-overlay"
                  >
                    <AppLogo kind={app.kind} className="size-10" />
                    <span className="flex flex-col gap-0.5">
                      <span className="break-words text-base font-semibold">{app.name}</span>
                      <span className="text-small font-light text-secondary">By Rawr</span>
                    </span>
                    <span className="flex-1 font-light">{app.purpose}</span>
                    <span className="flex flex-wrap gap-1.5">
                      {[app.appType, app.category].map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex h-5 items-center rounded-pill border border-canvas bg-canvas px-2 text-[0.625rem] font-semibold"
                        >
                          {tag}
                        </span>
                      ))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}
