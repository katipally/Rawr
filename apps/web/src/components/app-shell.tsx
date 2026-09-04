'use client'

import {
  ChevronsLeft,
  ChevronsRight,
  Contact,
  Database,
  Home,
  Inbox,
  PanelLeft,
  Settings,
  type LucideIcon,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn, Spinner } from '@rawr/ui'
import { NavigationProgress, NavigationProvider, useNavigation } from './navigation.tsx'
import { ThemeToggle } from './theme.tsx'

export type NavItem = {
  href: string
  label: string
  /** The path prefix that counts as "you are here". A deals tab stays lit on the
   *  board as well as the list, which share a prefix but not a href. */
  match?: string
}

/** A section is one icon on the rail. With groups it opens a flyout listing them;
 *  with only a href it is a plain link, which is what Home is. */
export type NavSection = {
  key: string
  label: string
  icon: IconKey
  href?: string
  groups?: NavItem[][]
}

/** Icons cross the server/client boundary as names. A component reference is
 *  not serialisable, so the layout names the icon and the rail resolves it. */
export type IconKey = 'home' | 'crm' | 'capture' | 'data'

const ICONS: Record<IconKey, LucideIcon> = {
  home: Home,
  crm: Contact,
  capture: Inbox,
  data: Database,
}

export type WorkspaceOption = { slug: string; name: string }

export type AppShellProps = {
  workspaceName: string
  workspaceSlug: string
  /** Every workspace this person belongs to. One entry means no switcher. */
  workspaces: WorkspaceOption[]
  email: string
  role: string
  /** Built by the layout from the session's workspace, because every CRM address
   *  carries its workspace and a hardcoded list could not. */
  nav: NavSection[]
  settingsHref: string
  /** The signed-in person's own screen, behind their name in the top bar. */
  accountHref: string
  /** The command palette, rendered by the layout so the shell needs no data. */
  search?: ReactNode
  children: ReactNode
}

const RAIL_KEY = 'rawr.rail.expanded'
/** How long the pointer may be between the rail and its flyout before the flyout
 *  closes. Long enough to cross the gap diagonally, short enough not to linger. */
const CLOSE_DELAY_MS = 160

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

/** HubSpot's rail: a navy strip of icons, collapsed by default, that opens a
 *  flyout of links when an icon is hovered or focused, and pins open to icons
 *  plus labels when asked. Below the sidebar breakpoint the same sections render
 *  as a sheet with inline lists, because hover does not exist on a phone. */
export const AppShell = (props: AppShellProps) => (
  <NavigationProvider>
    <Shell {...props} />
  </NavigationProvider>
)

const Shell = ({
  workspaceName,
  workspaceSlug,
  workspaces,
  email,
  role,
  nav,
  settingsHref,
  accountHref,
  search,
  children,
}: AppShellProps) => {
  const pathname = usePathname()
  const { pendingHref } = useNavigation()
  // Where the person is going counts as where they are, from the click onward.
  const here = pendingHref?.split('?')[0] ?? pathname
  const [sheetOpen, setSheetOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  /** Which section's flyout is showing on a wide screen. */
  const [flyout, setFlyout] = useState<string | null>(null)
  /** Which sections are unfolded inside the phone sheet. */
  const [unfolded, setUnfolded] = useState<string[]>([])
  const closeTimer = useRef<number | null>(null)
  const railRef = useRef<HTMLElement>(null)

  useEffect(() => setExpanded(read(RAIL_KEY) === '1'), [])

  // Neither the sheet nor a flyout survives a navigation, or the new page loads
  // with the menu still covering it. pathname is the trigger rather than
  // something the body reads, which is the whole point of the effect: drop it and
  // this runs once on mount and the menu stays up for the rest of the session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    setSheetOpen(false)
    setFlyout(null)
  }, [pathname])

  // Stable: this is the unmount cleanup below, and a new identity every render
  // would tear the timer down on each one, so the flyout would never linger.
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = null
  }, [])
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setFlyout(null), CLOSE_DELAY_MS)
  }
  useEffect(() => cancelClose, [cancelClose])

  const onKey = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Escape') setFlyout(null)
  }, [])
  useEffect(() => {
    if (!flyout) return
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [flyout, onKey])

  const isCurrent = (item: NavItem) => {
    const prefix = item.match ?? item.href
    return prefix === '/' ? here === '/' : here.startsWith(prefix)
  }
  const sectionIsCurrent = (section: NavSection) =>
    section.href
      ? here.startsWith(section.href)
      : (section.groups ?? []).some((group) => group.some(isCurrent))

  const onSettings = here.startsWith(settingsHref.split('/').slice(0, 2).join('/'))
  const open = flyout ? nav.find((section) => section.key === flyout) : null
  /** The flyout sits level with its icon; measured on open so it follows the
   *  rail whether collapsed or expanded, and at any zoom. */
  const [flyoutTop, setFlyoutTop] = useState(0)

  const showFlyout = (section: NavSection, target: HTMLElement) => {
    if (!section.groups) return
    cancelClose()
    const railTop = railRef.current?.getBoundingClientRect().top ?? 0
    setFlyoutTop(target.getBoundingClientRect().top - railTop)
    setFlyout(section.key)
  }

  const itemLinks = (section: NavSection, dense: boolean) =>
    (section.groups ?? []).map((group, index) => (
      <ul
        key={index}
        className={cn('flex flex-col', index > 0 && 'mt-1 border-t border-nav-active/60 pt-1')}
      >
        {group.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={isCurrent(item) ? 'page' : undefined}
              className={cn(
                'block border-l-2 no-underline',
                dense ? 'py-1.5 pr-3 pl-3' : 'py-2 pr-4 pl-4',
                isCurrent(item)
                  ? 'border-nav-accent bg-nav-active text-nav-text'
                  : 'border-transparent text-nav-muted hover:bg-nav-hover hover:text-nav-text',
              )}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    ))

  /** The wide-screen rail. */
  const rail = (
    <nav
      ref={railRef}
      aria-label="Sections"
      onMouseLeave={scheduleClose}
      onMouseEnter={cancelClose}
      className="relative flex min-h-0 flex-1 flex-col py-2"
    >
      {nav.map((section) => {
        const Icon = ICONS[section.icon]
        const here = sectionIsCurrent(section)
        const showing = flyout === section.key
        const face = cn(
          'flex w-full items-center gap-3 border-l-2 px-3 py-2.5 text-left no-underline',
          here ? 'border-nav-accent bg-nav-active text-nav-text' : 'border-transparent text-nav-muted',
          showing && !here && 'bg-nav-hover text-nav-text',
          'hover:bg-nav-hover hover:text-nav-text focus-visible:bg-nav-hover focus-visible:text-nav-text focus-visible:outline-none',
        )
        const body = (
          <>
            <Icon aria-hidden="true" className="size-5 shrink-0" />
            <span className={cn('min-w-0 flex-1 truncate font-medium', !expanded && 'sr-only')}>
              {section.label}
            </span>
          </>
        )

        if (section.href) {
          return (
            <Link
              key={section.key}
              href={section.href}
              title={expanded ? undefined : section.label}
              aria-current={here ? 'page' : undefined}
              onMouseEnter={() => setFlyout(null)}
              onFocus={() => setFlyout(null)}
              className={face}
            >
              {body}
            </Link>
          )
        }

        return (
          <button
            key={section.key}
            type="button"
            title={expanded ? undefined : section.label}
            aria-haspopup="true"
            aria-expanded={showing}
            aria-controls={`flyout-${section.key}`}
            onMouseEnter={(event) => showFlyout(section, event.currentTarget)}
            onFocus={(event) => showFlyout(section, event.currentTarget)}
            onClick={(event) => (showing ? setFlyout(null) : showFlyout(section, event.currentTarget))}
            className={face}
          >
            {body}
          </button>
        )
      })}

      {open?.groups ? (
        // A navigation flyout, not a set of form controls, so <fieldset> would be
        // the wrong element. The role and the section's own name are what tie
        // these links back to the rail item that opened them.
        // biome-ignore lint/a11y/useSemanticElements: see above
        <div
          id={`flyout-${open.key}`}
          role="group"
          aria-label={open.label}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          style={{ top: flyoutTop }}
          className="absolute left-full z-40 w-56 rounded-r-panel border-l border-nav-active bg-nav py-1 text-nav-text shadow-overlay"
        >
          {/* The rail already says which section this is when it is pinned open;
              only an icon-only rail needs the name repeated here. */}
          {expanded ? null : (
            <p className="px-3 pt-1 pb-2 text-small font-semibold uppercase tracking-wider text-nav-muted/70">
              {open.label}
            </p>
          )}
          {itemLinks(open, true)}
        </div>
      ) : null}
    </nav>
  )

  const switcher = (
    <label className="flex items-center">
      <span className="sr-only">Workspace</span>
      <select
        value={workspaceSlug}
        title={`${email} · ${role}`}
        onChange={(event) => {
          // The switch handler re-reads the membership before it changes
          // anything, so the selection is a request, never proof.
          const target = new URL('/api/auth/workspace', window.location.origin)
          target.searchParams.set('to', event.target.value)
          window.location.assign(target.toString())
        }}
        className="max-w-48 min-h-8 truncate rounded-hs border border-line bg-surface pl-2 pr-7 text-small"
      >
        {workspaces.map((option) => (
          <option key={option.slug} value={option.slug}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  )

  /** The phone sheet: same sections, inline lists, no hover. Ends with who is
   *  signed in and, for members of more than one workspace, the switcher the
   *  top bar has no room for at this width. */
  const sheet = (
    <nav aria-label="Sections" className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
      {nav.map((section) => {
        const Icon = ICONS[section.icon]
        const here = sectionIsCurrent(section)
        const isOpen = unfolded.includes(section.key) || here
        const face = cn(
          'flex w-full items-center gap-3 border-l-2 px-3 py-2.5 text-left no-underline',
          here ? 'border-nav-accent text-nav-text' : 'border-transparent text-nav-muted',
        )
        if (section.href) {
          return (
            <Link key={section.key} href={section.href} aria-current={here ? 'page' : undefined} className={face}>
              <Icon aria-hidden="true" className="size-5 shrink-0" />
              <span className="font-medium">{section.label}</span>
            </Link>
          )
        }
        return (
          <div key={section.key}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() =>
                setUnfolded((keys) => (keys.includes(section.key) ? keys.filter((k) => k !== section.key) : [...keys, section.key]))
              }
              className={face}
            >
              <Icon aria-hidden="true" className="size-5 shrink-0" />
              <span className="font-medium">{section.label}</span>
            </button>
            {isOpen ? <div className="pb-1 pl-6">{itemLinks(section, true)}</div> : null}
          </div>
        )
      })}
    </nav>
  )

  return (
    // The shell owns the scroll: the viewport is exactly one screen tall and only
    // <main> moves. That is what lets a table header stick and keeps the rail and
    // the top bar from scrolling away.
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="relative z-40 flex h-12 shrink-0 items-center gap-3 border-b border-divider bg-surface px-3">
        <NavigationProgress />
        <button
          type="button"
          aria-expanded={sheetOpen}
          aria-controls="primary-nav"
          aria-label="Menu"
          onClick={() => setSheetOpen((value) => !value)}
          className="rounded-hs p-1.5 text-body hover:bg-fill-hover md:hidden"
        >
          <PanelLeft aria-hidden="true" className="size-5" />
        </button>

        <Link href="/" className="shrink-0 font-semibold tracking-tight text-cta no-underline">
          Rawr
        </Link>

        {search ? <div className="ml-auto w-full min-w-0 max-w-md">{search}</div> : null}

        <div className={cn('flex shrink-0 items-center gap-2', search ? '' : 'ml-auto')}>
          {workspaces.length > 1 ? (
            <label className="hidden items-center lg:flex">
              <span className="sr-only">Workspace</span>
              <select
                value={workspaceSlug}
                title={`${email} · ${role}`}
                onChange={(event) => {
                  // The switch handler re-reads the membership before it changes
                  // anything, so the selection is a request, never proof.
                  const target = new URL('/api/auth/workspace', window.location.origin)
                  target.searchParams.set('to', event.target.value)
                  window.location.assign(target.toString())
                }}
                className="max-w-48 min-h-8 truncate rounded-hs border border-line bg-surface pl-2 pr-7 text-small"
              >
                {workspaces.map((option) => (
                  <option key={option.slug} value={option.slug}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <Link
              href={accountHref}
              className="hidden max-w-40 truncate text-secondary no-underline hover:text-body lg:inline"
              title={`${email} · ${role}. Your account.`}
            >
              {workspaceName}
            </Link>
          )}
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
            <button type="submit" className="rounded-hs border border-line px-2 py-1 font-medium hover:bg-fill-hover">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Wide screens: the rail. The flyout is positioned against it, so it
            must not clip on the x axis. */}
        <aside
          className={cn(
            'z-30 hidden flex-col bg-nav text-nav-text transition-[width] duration-200 md:flex',
            expanded ? 'w-52' : 'w-14',
          )}
        >
          <button
            type="button"
            onClick={() => {
              setExpanded(!expanded)
              write(RAIL_KEY, expanded ? '0' : '1')
              setFlyout(null)
            }}
            aria-pressed={expanded}
            title={expanded ? 'Collapse' : 'Expand'}
            className="flex shrink-0 items-center gap-3 border-b border-nav-active/60 px-3 py-2.5 text-nav-muted hover:bg-nav-hover hover:text-nav-text"
          >
            {expanded ? (
              <ChevronsLeft aria-hidden="true" className="size-5 shrink-0" />
            ) : (
              <ChevronsRight aria-hidden="true" className="size-5 shrink-0" />
            )}
            <span className={expanded ? 'truncate' : 'sr-only'}>{expanded ? 'Collapse' : 'Expand'}</span>
          </button>
          {rail}
        </aside>

        {/* Phones: the same sections as a sheet over the content. */}
        {sheetOpen ? (
          <>
            <div id="primary-nav" className="fixed inset-y-12 left-0 z-30 flex w-64 flex-col bg-nav text-nav-text md:hidden">
              {sheet}
              <div className="flex flex-col gap-2 border-t border-nav-active/60 px-3 py-3 text-small text-nav-muted">
                <Link href={accountHref} className="truncate text-nav-muted no-underline hover:text-nav-text" title={email}>
                  {email} · {role}
                </Link>
                {workspaces.length > 1 ? switcher : <span className="truncate">{workspaceName}</span>}
              </div>
            </div>
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setSheetOpen(false)}
              className="fixed inset-x-0 top-12 bottom-0 z-20 cursor-default bg-scrim md:hidden"
            />
          </>
        ) : null}

        {/* Full bleed: this is a data tool, and a wide screen is there to be used.
            This is the one scrolling box on the page. */}
        <main
          aria-busy={pendingHref ? 'true' : undefined}
          className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto p-3 sm:p-6"
        >
          {children}
          {pendingHref ? (
            // The old screen stays put but steps back, and the spinner says the
            // new one is on its way. Replaced by the route's own loading state the
            // moment the server starts streaming it.
            <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center bg-canvas/60 pt-[20vh]">
              <Spinner size="lg" label="Opening" />
            </div>
          ) : null}
        </main>
      </div>
    </div>
  )
}
