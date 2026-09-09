'use client'

import { cn } from '@rawr/ui'
import { ChevronLeft, Search } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'
import type { SettingsGroup } from '~/lib/settings-nav.ts'

/** Labels only. Every settings page opens with its own title and a sentence
 *  saying what it is for, so repeating that sentence sixteen times in the rail
 *  made a list of sixteen names into a wall of prose nobody reads. */
export const SettingsNav = ({ groups, backHref }: { groups: SettingsGroup[]; backHref: string }) => {
  const pathname = usePathname()
  const [needle, setNeedle] = useState('')
  // The query string on a properties link picks an object, not a page, so the
  // comparison is on the path alone.
  const pathOf = (href: string) => href.split('?')[0] ?? href
  const wanted = needle.trim().toLowerCase()
  const shown = groups
    .map((group) => ({ ...group, sections: group.sections.filter((section) => section.label.toLowerCase().includes(wanted)) }))
    .filter((group) => group.sections.length > 0)

  return (
    <nav aria-label="Settings" className="min-w-0">
      <div className="flex flex-col gap-3 border-b border-line p-6">
        <Link href={backHref} className="flex items-center gap-1 text-small text-body no-underline hover:underline">
          <ChevronLeft aria-hidden="true" className="size-4" />
          Back
        </Link>
        <label className="relative block">
          <span className="sr-only">Search settings</span>
          <input
            type="search"
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            placeholder="Search Settings"
            className="h-10 w-full rounded-pill border border-line-strong bg-surface pr-10 pl-4 text-base outline-none focus:border-body"
          />
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2" />
        </label>
      </div>
      <ul className="flex flex-col gap-6 p-6">
        {shown.map((group) => (
          <li key={group.label}>
            <h2 className="mb-2 text-base font-semibold">{group.label}</h2>
            <ul className="flex flex-col">
              {group.sections.map((section) => {
                const current = pathname.startsWith(pathOf(section.href))
                return (
                  <li key={section.href}>
                    <Link
                      href={section.href}
                      aria-current={current ? 'page' : undefined}
                      className={cn(
                        'block truncate border-l-[3px] py-[0.4375rem] pr-3 pl-[calc(0.75rem-3px)] font-light text-body no-underline',
                        current ? 'border-body bg-canvas' : 'border-transparent hover:bg-fill',
                      )}
                    >
                      {section.label}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
        {shown.length === 0 ? <li className="text-secondary">Nothing matches.</li> : null}
      </ul>
    </nav>
  )
}
