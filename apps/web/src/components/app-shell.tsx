'use client'

import {
  ChevronDown,
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

const RAIL_KEY = 'rawr.rail.collapsed'
const OPEN_KEY = 'rawr.rail.sections'

const read = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key)
  } catch {
    // Private windows and blocked site data are normal, not an error.
    return null
  }
}

const write = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The rail still works for this page view.
  }
}

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
  /** Below the sidebar's breakpoint the rail becomes a sheet over the content. */
  const [sheetOpen, setSheetOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  /** Which sections are expanded. Every section starts open, because the whole
   *  point of the rebuild is that the links are visible without hunting. */
  const [openKeys, setOpenKeys] = useState<string[]>(() => nav.map((section) => section.key))

  useEffect(() => {
    setCollapsed(read(RAIL_KEY) === '1')
    const stored = read(OPEN_KEY)
    if (stored !== null) setOpenKeys(stored === '' ? [] : stored.split(','))
  }, [])

  // The sheet must not survive a navigation, or a phone lands on the new page
  // with the menu still covering it.
  useEffect(() => setSheetOpen(false), [pathname])

  const setRail = (next: boolean) => {
    setCollapsed(next)
    write(RAIL_KEY, next ? '1' : '0')
  }

  const toggleSection = (key: string) => {
    const next = openKeys.includes(key) ? openKeys.filter((k) => k !== key) : [...openKeys, key]
    setOpenKeys(next)
    write(OPEN_KEY, next.join(','))
  }

  const isCurrent = (item: NavItem) => {
    const prefix = item.match ?? item.href
    return prefix === '/' ? pathname === '/' : pathname.startsWith(prefix)
  }

  const sectionIsCurrent = (section: NavSection) =>
    section.groups.some((group) => group.some(isCurrent))

  const onSettings = pathname.startsWith(settingsHref.split('/').slice(0, 2).join('/'))

  const sidebar = (
    <nav aria-label="Sections" className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      {nav.map((section) => {
        const Icon = ICONS[section.icon]
        const here = sectionIsCurrent(section)
        // A collapsed rail has no room for a list, so the section header becomes
        // the link to its own first destination rather than a dead icon.
        const open = openKeys.includes(section.key)
        const first = section.groups[0]?.[0]

        if (collapsed) {
          return (
            <Link
              key={section.key}
              href={first?.href ?? '/'}
              title={section.label}
              aria-current={here ? 'true' : undefined}
              className={cn(
                'flex items-center justify-center rounded-hs p-2 no-underline',
                here ? 'bg-accent-subtle text-link' : 'text-body hover:bg-fill-hover',
              )}
            >
              <Icon aria-hidden="true" className="size-5 shrink-0" />
              <span className="sr-only">{section.label}</span>
            </Link>
          )
        }

        return (
          <div key={section.key} className="flex flex-col">
            <button
              type="button"
              aria-expanded={open}
              onClick={() => toggleSection(section.key)}
              className={cn(
                'flex w-full items-center gap-2 rounded-hs px-2 py-2 text-left',
                here ? 'text-link' : 'text-body',
                'hover:bg-fill-hover',
              )}
            >
              <Icon aria-hidden="true" className="size-5 shrink-0" />
              <span className="min-w-0 flex-1 truncate font-medium">{section.label}</span>
              <ChevronDown
                aria-hidden="true"
                className={cn(
                  'size-4 shrink-0 text-secondary transition-transform duration-150',
                  !open && '-rotate-90',
                )}
              />
            </button>

            {open
              ? section.groups.map((group, index) => (
                  <ul
                    key={index}
                    // The divider is the grouping. It earns its space only between groups.
                    className={cn('flex flex-col', index > 0 && 'mt-1 border-t border-divider pt-1')}
                  >
                    {group.map((item) => (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={isCurrent(item) ? 'page' : undefined}
                          className={cn(
                            // The 2px bar is the active state, the way HubSpot's is.
                            // Colour alone would be the only signal otherwise.
                            'ml-3 block border-l-2 py-1.5 pl-4 no-underline',
                            isCurrent(item)
                              ? 'border-accent bg-accent-subtle font-medium text-link'
                              : 'border-transparent text-body hover:border-line hover:bg-fill-hover',
                          )}
                        >
                          {item.label}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ))
              : null}
          </div>
        )
      })}
    </nav>
  )

  return (
    // The shell owns the scroll: the viewport is exactly one screen tall and only
    // <main> moves. That is what lets a table header stick, what keeps the rail
    // and the top bar from scrolling away, and what stops the double scrollbar a
    // page-level scroller plus a table-level one would produce.
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="z-40 flex h-12 shrink-0 items-center gap-3 border-b border-divider bg-surface px-3">
        <button
          type="button"
          aria-expanded={sheetOpen}
          aria-controls="primary-nav"
          aria-label="Menu"
          onClick={() => setSheetOpen((open) => !open)}
          className="rounded-hs p-1.5 text-body hover:bg-fill-hover md:hidden"
        >
          <PanelLeft aria-hidden="true" className="size-5" />
        </button>

        <Link
          href="/"
          className="shrink-0 font-semibold tracking-tight text-cta no-underline"
        >
          Rawr
        </Link>

        {/* The search takes the room that is left, and stops growing before it
            crowds the account controls off a laptop screen. */}
        {search ? <div className="ml-auto w-full min-w-0 max-w-md">{search}</div> : null}

        <div className={cn('flex shrink-0 items-center gap-2', search ? '' : 'ml-auto')}>
          <span
            className="hidden max-w-40 truncate text-secondary lg:inline"
            title={`${email} · ${role}`}
          >
            {workspaceName}
          </span>
          <Link
            href={settingsHref}
            aria-label="Settings"
            aria-current={onSettings ? 'page' : undefined}
            className={cn(
              'rounded-hs p-1.5 no-underline',
              onSettings ? 'bg-accent-subtle text-link' : 'text-body hover:bg-fill-hover',
            )}
          >
            <Settings aria-hidden="true" className="size-5" />
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
      </header>

      <div className="flex min-h-0 flex-1">
        <div
          className={cn(
            'z-30 flex flex-col border-r border-divider bg-surface',
            'transition-[width] duration-200',
            // Below the breakpoint the same markup floats over the content as a
            // sheet, so there is one navigation to keep correct rather than two.
            'max-md:fixed max-md:inset-y-12 max-md:left-0',
            collapsed ? 'md:w-14' : 'md:w-60',
            sheetOpen ? 'w-64' : 'hidden md:flex',
          )}
          id="primary-nav"
        >
          {sidebar}

          <button
            type="button"
            onClick={() => setRail(!collapsed)}
            aria-pressed={collapsed}
            className="hidden shrink-0 items-center gap-2 border-t border-divider px-3 py-2 text-secondary hover:bg-fill-hover md:flex"
          >
            <PanelLeft aria-hidden="true" className="size-4 shrink-0" />
            <span className={collapsed ? 'sr-only' : 'truncate'}>Collapse</span>
          </button>
        </div>

        {/* The scrim only exists for the sheet, and only below the breakpoint. */}
        {sheetOpen ? (
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setSheetOpen(false)}
            className="fixed inset-x-0 top-12 bottom-0 z-20 cursor-default bg-scrim md:hidden"
          />
        ) : null}

        {/* Full bleed: this is a data tool, and a wide screen is there to be used.
            This is the one scrolling box on the page. A surface that wants to fill
            the screen instead of scrolling gives its own root h-full. */}
        <main className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto p-3 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  )
}
