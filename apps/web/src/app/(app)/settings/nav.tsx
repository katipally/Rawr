'use client'

import { cn } from '@rawr/ui'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export type SettingsSection = { href: string; label: string; hint: string }
export type SettingsGroup = { label: string; sections: SettingsSection[] }

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
                        'block rounded-hs px-2 py-1.5 no-underline',
                        current ? 'bg-accent-subtle text-link' : 'text-body hover:bg-fill',
                      )}
                    >
                      <span className="block font-medium">{section.label}</span>
                      <span className="block text-small text-secondary">{section.hint}</span>
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
