'use client'

import { cn } from '@rawr/ui'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export type SettingsSection = { href: string; label: string }
export type SettingsGroup = { label: string; sections: SettingsSection[] }

/** Labels only. Every settings page opens with its own title and a sentence
 *  saying what it is for, so repeating that sentence sixteen times in the rail
 *  made a list of sixteen names into a wall of prose nobody reads. */
export const SettingsNav = ({ groups }: { groups: SettingsGroup[] }) => {
  const pathname = usePathname()
  // The query string on a properties link picks an object, not a page, so the
  // comparison is on the path alone.
  const pathOf = (href: string) => href.split('?')[0] ?? href

  return (
    <nav aria-label="Settings" className="min-w-0">
      <ul className="flex flex-col gap-4">
        {groups.map((group) => (
          <li key={group.label}>
            <h2 className="mb-1 px-2 text-small font-medium uppercase tracking-wide text-secondary">
              {group.label}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {group.sections.map((section) => {
                const current = pathname.startsWith(pathOf(section.href))
                return (
                  <li key={section.href}>
                    <Link
                      href={section.href}
                      aria-current={current ? 'page' : undefined}
                      className={cn(
                        'block truncate rounded-hs px-2 py-1.5 font-medium no-underline',
                        current ? 'bg-accent-subtle text-link' : 'text-body hover:bg-fill',
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
      </ul>
    </nav>
  )
}
