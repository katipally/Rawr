'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import { cn } from '@rawr/ui'
import { ThemeToggle } from './theme.tsx'

export type NavItem = { href: string; label: string }

/** Feature surfaces are added here as they land, so the nav never lists a screen
 *  that does not exist yet. */
export const NAV: NavItem[] = [
  { href: '/', label: 'Home' },
  { href: '/design', label: 'Design' },
  { href: '/settings/jobs', label: 'Failed jobs' },
]

export type AppShellProps = {
  workspaceName: string
  email: string
  role: string
  children: ReactNode
}

export const AppShell = ({ workspaceName, email, role, children }: AppShellProps) => {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)

  const isCurrent = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href))

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-divider bg-surface">
        <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5">
          <Link href="/" className="font-semibold tracking-tight text-cta no-underline">
            Rawr
          </Link>

          {/* Collapses to a toggle on narrow viewports rather than overflowing. */}
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((open) => !open)}
            className="ml-auto rounded-hs border border-line px-2 py-1 sm:hidden"
          >
            Menu
          </button>

          <nav
            id="primary-nav"
            aria-label="Primary"
            className={cn(
              'order-last w-full sm:order-none sm:mr-auto sm:w-auto',
              menuOpen ? 'block' : 'hidden sm:block',
            )}
          >
            <ul className="flex flex-wrap gap-1">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={isCurrent(item.href) ? 'page' : undefined}
                    onClick={() => setMenuOpen(false)}
                    className={cn(
                      'block rounded-hs px-3 py-1.5 font-medium text-body no-underline',
                      'hover:bg-fill-hover',
                      isCurrent(item.href) && 'bg-accent-subtle text-link',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div className="hidden min-w-0 items-center gap-3 sm:flex">
            <span className="truncate text-secondary" title={`${email} · ${role}`}>
              {workspaceName}
            </span>
            <ThemeToggle />
            <form action="/api/auth/sign-out" method="post">
              <button
                type="submit"
                className="rounded-hs border border-line px-2 py-1 font-medium hover:bg-fill-hover"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      {/* Full bleed: this is a data tool, and a wide screen is there to be used. */}
      <main className="w-full flex-1 p-3 sm:p-6">{children}</main>
    </div>
  )
}
