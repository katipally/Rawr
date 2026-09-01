'use client'

import {
  ChevronLeft,
  ChevronRight,
  Contact,
  Database,
  Inbox,
  PanelLeft,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@rawr/ui'
import { ThemeToggle } from './theme.tsx'

export type NavItem = {
  href: string
  label: string
  /** The path prefix that counts as "you are here". A deals tab stays lit on the
   *  board as well as the list, which share a prefix but not a href. */
  match?: string
}

/** Sections carry groups rather than a flat list so a divider can separate the
 *  three record types from the things built on top of them. Grouping is the
 *  whole point of the rail: ten items in a row are ten equal choices, three
 *  sections of three or four are a shape somebody can learn. */
export type NavSection = {
  key: string
  label: string
  icon: IconKey
  groups: NavItem[][]
}

/** Icons cross the server/client boundary as names. A component reference is
 *  not serialisable, so the layout names the icon and the rail resolves it. */
export type IconKey = 'crm' | 'capture' | 'data'

const ICONS: Record<IconKey, LucideIcon> = {
  crm: Contact,
  capture: Inbox,
  data: Database,
}

export type AppShellProps = {
  workspaceName: string
  email: string
  role: string
  /** Built by the layout from the session's workspace, because every CRM address
   *  carries its workspace and a hardcoded list could not. */
  nav: NavSection[]
  settingsHref: string
  /** The command palette, rendered by the layout so the shell needs no data. */
  search?: ReactNode
  children: ReactNode
}

const RAIL_KEY = 'rawr.rail.expanded'

export const AppShell = ({
  workspaceName,
  email,
  role,
  nav,
  settingsHref,
  search,
  children,
}: AppShellProps) => {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  /** Which section's flyout is showing. Hover opens it, but it is state rather
   *  than :hover so a keyboard and a touch screen can open the same panel. */
  const [openSection, setOpenSection] = useState<string | null>(null)

  useEffect(() => {
    try {
      setExpanded(window.localStorage.getItem(RAIL_KEY) === '1')
    } catch {
      // Private windows and blocked site data are normal, not an error.
    }
  }, [])

  const setRail = (next: boolean) => {
    setExpanded(next)
    try {
      window.localStorage.setItem(RAIL_KEY, next ? '1' : '0')
    } catch {
      // The rail still works for this page view.
    }
  }

  const isCurrent = (item: NavItem) => {
    const prefix = item.match ?? item.href
    return prefix === '/' ? pathname === '/' : pathname.startsWith(prefix)
  }

  const sectionIsCurrent = (section: NavSection) =>
    section.groups.some((group) => group.some(isCurrent))

  const onSettings = pathname.startsWith(settingsHref.split('/').slice(0, 2).join('/'))

  const links = (section: NavSection, onNavigate: () => void) =>
    section.groups.map((group, index) => (
      <ul
        key={index}
        className={cn(
          'flex flex-col',
          // The divider is the grouping. It only earns its space between groups.
          index > 0 && 'mt-2 border-t border-divider pt-2',
        )}
      >
        {group.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={isCurrent(item) ? 'page' : undefined}
              onClick={onNavigate}
              className={cn(
                'block rounded-hs px-2 py-1.5 no-underline hover:bg-fill-hover',
                isCurrent(item) ? 'bg-accent-subtle font-medium text-link' : 'text-body',
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    ))

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-divider bg-surface">
        <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 px-3 py-1.5">
          <Link href="/" className="font-semibold tracking-tight text-cta no-underline">
            Rawr
          </Link>

          {/* Below the rail's breakpoint the whole navigation folds into here. */}
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((open) => !open)}
            className="ml-auto flex items-center gap-1 rounded-hs border border-line px-2 py-1 sm:hidden"
          >
            <PanelLeft aria-hidden="true" className="size-4" />
            Menu
          </button>

          {search ? (
            <div className="order-last w-full min-w-0 sm:order-none sm:ml-auto sm:w-72">{search}</div>
          ) : null}

          {/* Settings and search stay in the top bar; the rail is for the work. */}
          <div
            className={cn(
              'order-last min-w-0 items-center gap-3 sm:order-none sm:flex sm:w-auto',
              menuOpen ? 'flex w-full' : 'hidden',
            )}
          >
            <span className="truncate text-secondary" title={`${email} · ${role}`}>
              {workspaceName}
            </span>
            <Link
              href={settingsHref}
              aria-label="Settings"
              aria-current={onSettings ? 'page' : undefined}
              className={cn(
                'flex items-center gap-1 rounded-hs border border-line px-2 py-1 no-underline',
                onSettings ? 'bg-accent-subtle text-link' : 'text-body hover:bg-fill-hover',
              )}
            >
              <Settings aria-hidden="true" className="size-4" />
              <span className="sm:sr-only">Settings</span>
            </Link>
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

          {/* The narrow-screen navigation: every section, flattened, because a
              flyout that opens on hover has nothing to open on. */}
          <nav
            id="primary-nav"
            aria-label="Primary"
            className={cn('order-last w-full sm:hidden', menuOpen ? 'block' : 'hidden')}
          >
            {nav.map((section) => (
              <div key={section.key} className="py-1">
                <p className="px-2 text-small font-medium text-secondary uppercase">{section.label}</p>
                {links(section, () => setMenuOpen(false))}
              </div>
            ))}
          </nav>
        </div>
      </header>

      <div className="flex flex-1">
        <nav
          aria-label="Sections"
          onMouseLeave={() => setOpenSection(null)}
          className={cn(
            'sticky top-12 z-30 hidden h-[calc(100dvh-3rem)] shrink-0 flex-col border-r border-divider bg-surface p-2 sm:flex',
            expanded ? 'w-60' : 'w-14',
          )}
        >
          {nav.map((section) => {
            const Icon = ICONS[section.icon]
            const here = sectionIsCurrent(section)
            const open = openSection === section.key
            return (
              <div
                key={section.key}
                className="relative"
                onMouseEnter={() => setOpenSection(section.key)}
              >
                <button
                  type="button"
                  aria-expanded={open}
                  aria-haspopup="true"
                  onClick={() => setOpenSection(open ? null : section.key)}
                  onFocus={() => setOpenSection(section.key)}
                  onKeyDown={(event) => event.key === 'Escape' && setOpenSection(null)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-hs px-2 py-2 text-left',
                    here ? 'bg-accent-subtle text-link' : 'hover:bg-fill-hover',
                  )}
                >
                  <Icon aria-hidden="true" className="size-5 shrink-0" />
                  {expanded ? (
                    <>
                      <span className="min-w-0 flex-1 truncate font-medium">{section.label}</span>
                      <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-secondary" />
                    </>
                  ) : (
                    <span className="sr-only">{section.label}</span>
                  )}
                </button>

                {open ? (
                  <div
                    // Left-aligned to the rail's edge so the panel is the same
                    // width whether the rail is collapsed or expanded.
                    className="absolute top-0 left-full z-40 ml-1 w-56 rounded-panel border border-line bg-surface p-2 shadow-overlay"
                    onKeyDown={(event) => event.key === 'Escape' && setOpenSection(null)}
                  >
                    <p className="px-2 pb-1 font-medium">{section.label}</p>
                    {links(section, () => setOpenSection(null))}
                  </div>
                ) : null}
              </div>
            )
          })}

          <button
            type="button"
            onClick={() => setRail(!expanded)}
            aria-pressed={expanded}
            className="mt-auto flex items-center gap-2 rounded-hs px-2 py-2 text-secondary hover:bg-fill-hover"
          >
            {expanded ? (
              <ChevronLeft aria-hidden="true" className="size-5 shrink-0" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-5 shrink-0" />
            )}
            <span className={expanded ? 'truncate' : 'sr-only'}>Collapse</span>
          </button>
        </nav>

        {/* Full bleed: this is a data tool, and a wide screen is there to be used. */}
        <main className="w-full min-w-0 flex-1 p-3 sm:p-6">{children}</main>
      </div>
    </div>
  )
}
