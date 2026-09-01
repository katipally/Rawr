'use client'

import { cn } from '@rawr/ui'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export type SettingsSection = { href: string; label: string; hint: string }

export const SettingsNav = ({ sections }: { sections: SettingsSection[] }) => {
  const pathname = usePathname()
  // The query string on a properties link picks an object, not a page, so the
  // comparison is on the path alone.
  const pathOf = (href: string) => href.split('?')[0] ?? href

  return (
    <nav aria-label="Settings" className="min-w-0">
      <h1 className="mb-2 text-lg font-medium">Settings</h1>
      <ul className="flex flex-col gap-0.5">
        {sections.map((section) => {
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
    </nav>
  )
}
