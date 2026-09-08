'use client'

import { Badge, EmptyState, Field, TextInput } from '@rawr/ui'
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
      <Field id="available-search" label="Search apps">
        <TextInput
          id="available-search"
          value={query}
          placeholder="Name, category or what it does"
          onChange={(event) => setQuery(event.target.value)}
        />
      </Field>

      {byCategory.size === 0 ? (
        <EmptyState title="Nothing matches" description="Try a shorter word, or clear the search." />
      ) : (
        [...byCategory].map(([category, list]) => (
          <section key={category} className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">{category}</h2>
            <ul className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3 @6xl:grid-cols-4">
              {list.map((app) => (
                <li key={app.kind} className="min-w-0">
                  <Link
                    href={appPath(app.kind)}
                    className="flex h-full flex-col gap-3 rounded-panel border border-line bg-surface p-5 text-body no-underline shadow-panel transition-shadow hover:shadow-md"
                  >
                    <AppLogo kind={app.kind} className="size-10" />
                    <span className="flex flex-col gap-0.5">
                      <span className="break-words font-semibold">{app.name}</span>
                      <span className="text-small text-secondary">By Rawr · {app.appType}</span>
                    </span>
                    <span className="flex-1 text-secondary">{app.purpose}</span>
                    <span>
                      <Badge>{app.category}</Badge>
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
