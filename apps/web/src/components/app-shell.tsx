'use client'

import {
  Bell,
  Building2,
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  CircleHelp,
  Contact,
  Handshake,
  ListChecks,
  LogOut,
  PanelLeft,
  Plus,
  Settings,
  UserRound,
  X,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Avatar, cn, DropdownMenu, IconButton, Spinner, type MenuGroup } from '@rawr/ui'
import { SECTION_ICONS, type IconKey } from './icons.ts'
import { NavigationProgress, NavigationProvider, useNavigation } from './navigation.tsx'
import { NotificationBell } from './notifications.tsx'
import { THEMES, useTheme } from './theme.tsx'

export type NavItem = {
  href: string
  label: string
  /** The path prefix that counts as "you are here". A deals tab stays lit on the
   *  board as well as the list, which share a prefix but not a href. */
  match?: string
}

/** A named run of items inside a section's flyout. HubSpot heads each run, which
 *  is what keeps a ten-item menu readable. */
export type NavGroup = { label?: string; items: NavItem[] }

/** A section is one icon on the rail. With groups it opens a flyout listing them;
 *  with only a href it is a plain link, which is what Home is. */
export type NavSection = {
  key: string
  label: string
  icon: IconKey
  href?: string
  groups?: NavGroup[]
}

export type WorkspaceOption = { slug: string; name: string; organisation?: string }

export type CreateOption = { key: string; label: string; href: string }

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
  /** What the + button offers. Addresses, so the menu needs no client data. */
  create: CreateOption[]
  settingsHref: string
  /** The signed-in person's own screen, behind their name in the top bar. */
  accountHref: string
  /** Where "Back" leaves settings when nothing else has been visited. */
  homeHref: string
  /** The command palette, rendered by the layout so the shell needs no data. */
  search?: ReactNode
  children: ReactNode
}

const RAIL_KEY = 'rawr.rail.expanded'
/** How long the pointer may be between the rail and its flyout before the flyout
 *  closes. Long enough to cross the gap diagonally, short enough not to linger. */
const CLOSE_DELAY_MS = 160

const CREATE_ICONS: Record<string, typeof Contact> = {
  contact: Contact,
  company: Building2,
  deal: Handshake,
  task: ListChecks,
}

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

/** HubSpot's frame: a navy rail down the full height with the wordmark on top, the
 *  top bar starting to its right, and the page itself a white card on the canvas.
 *  The rail opens a flyout of grouped links on hover or focus and pins open to
 *  icons plus labels when asked. Below the sidebar breakpoint the same sections
 *  render as a sheet, because hover does not exist on a phone. */
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
  create,
  settingsHref,
  accountHref,
  homeHref,
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
  const [theme, setTheme] = useTheme()

  const inSettings = here.startsWith('/settings')
  /** The last page outside settings, so Back returns where the person came from
   *  rather than always to Home. */
  const cameFrom = useRef(homeHref)
  useEffect(() => {
    if (!pathname.startsWith('/settings')) cameFrom.current = pathname
  }, [pathname])

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
      : (section.groups ?? []).some((group) => group.items.some(isCurrent))

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
      <div key={group.label ?? index} className={cn(index > 0 && 'mt-1 border-t border-nav-active/60 pt-1')}>
        {group.label ? (
          <p className="px-3 pt-1 pb-0.5 text-small font-medium uppercase tracking-wide text-nav-muted/70">
            {group.label}
          </p>
        ) : null}
        <ul className="flex flex-col">
          {group.items.map((item) => (
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
      </div>
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
        const Icon = SECTION_ICONS[section.icon]
        const current = sectionIsCurrent(section)
        const showing = flyout === section.key
        const face = cn(
          'flex w-full items-center gap-3 border-l-2 px-3 py-2.5 text-left no-underline',
          current ? 'border-nav-accent bg-nav-active text-nav-text' : 'border-transparent text-nav-muted',
          showing && !current && 'bg-nav-hover text-nav-text',
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
              aria-current={current ? 'page' : undefined}
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
          className="absolute left-full z-flyout w-56 rounded-r-panel border-l border-nav-active bg-nav py-1 text-nav-text shadow-overlay"
        >
          <p className="px-3 pt-1 pb-2 text-small font-semibold uppercase tracking-wider text-nav-muted/70">
            {open.label}
          </p>
          {itemLinks(open, true)}
        </div>
      ) : null}
    </nav>
  )

  const switchTo = (slug: string) => {
    // The switch handler re-reads the membership before it changes anything, so
    // the selection is a request, never proof.
    const target = new URL('/api/auth/workspace', window.location.origin)
    target.searchParams.set('to', slug)
    window.location.assign(target.toString())
  }

  /** Workspaces grouped by the organisation that owns them, so a person on two
   *  organisations sees which is which rather than one flat list of names. */
  const workspaceGroups: MenuGroup[] = (() => {
    const byOrg = new Map<string, WorkspaceOption[]>()
    for (const option of workspaces) {
      const key = option.organisation ?? ''
      byOrg.set(key, [...(byOrg.get(key) ?? []), option])
    }
    return [...byOrg.entries()].map(([organisation, options]) => ({
      key: organisation || 'workspaces',
      label: organisation || 'Workspaces',
      items: options.map((option) => ({
        key: option.slug,
        label: option.name,
        checked: option.slug === workspaceSlug,
        onSelect: () => switchTo(option.slug),
      })),
    }))
  })()

  const accountMenu: MenuGroup[] = [
    { key: 'you', items: [{ key: 'account', label: 'Your account', href: accountHref, icon: <UserRound className="size-4" /> }] },
    ...(workspaces.length > 1 ? workspaceGroups : []),
    {
      key: 'theme',
      label: 'Appearance',
      items: THEMES.map(({ value, label, icon: Icon }) => ({
        key: value,
        label,
        icon: <Icon className="size-4" />,
        checked: theme === value,
        onSelect: () => setTheme(value),
      })),
    },
  ]

  /** The phone sheet: same sections, inline lists, no hover. Ends with who is
   *  signed in and, for members of more than one workspace, the switcher the
   *  top bar has no room for at this width. */
  const sheet = (
    <nav aria-label="Sections" className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
      {nav.map((section) => {
        const Icon = SECTION_ICONS[section.icon]
        const current = sectionIsCurrent(section)
        const isOpen = unfolded.includes(section.key) || current
        const face = cn(
          'flex w-full items-center gap-3 border-l-2 px-3 py-2.5 text-left no-underline',
          current ? 'border-nav-accent text-nav-text' : 'border-transparent text-nav-muted',
        )
        if (section.href) {
          return (
            <Link key={section.key} href={section.href} aria-current={current ? 'page' : undefined} className={face}>
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
    // the top bar from scrolling away. The rail runs the full height with the bar
    // beside it, which is HubSpot's frame and what makes the wordmark sit over
    // the navigation rather than over the page.
    <div className="flex h-dvh overflow-hidden">
      {/* Wide screens: the rail. Hidden inside settings, which is its own place
          with its own navigation, exactly as HubSpot does it. */}
      {inSettings ? null : (
        <aside
          className={cn(
            'z-rail hidden shrink-0 flex-col bg-nav text-nav-text transition-[width] duration-200 md:flex',
            expanded ? 'w-rail-open' : 'w-rail',
          )}
        >
          <Link
            href={homeHref}
            aria-label="Rawr home"
            className="flex h-topbar shrink-0 items-center gap-2 border-b border-nav-active/60 px-3 font-semibold tracking-tight text-nav-text no-underline"
          >
            <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-hs bg-nav-accent text-inverse">
              R
            </span>
            <span className={expanded ? 'truncate' : 'sr-only'}>Rawr</span>
          </Link>
          {rail}
          <button
            type="button"
            onClick={() => {
              setExpanded(!expanded)
              write(RAIL_KEY, expanded ? '0' : '1')
              setFlyout(null)
            }}
            aria-pressed={expanded}
            title={expanded ? 'Collapse' : 'Expand'}
            className="flex shrink-0 items-center gap-3 border-t border-nav-active/60 px-3 py-2.5 text-nav-muted hover:bg-nav-hover hover:text-nav-text"
          >
            {expanded ? (
              <ChevronsLeft aria-hidden="true" className="size-5 shrink-0" />
            ) : (
              <ChevronsRight aria-hidden="true" className="size-5 shrink-0" />
            )}
            <span className={expanded ? 'truncate' : 'sr-only'}>{expanded ? 'Collapse' : 'Expand'}</span>
          </button>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-topbar flex h-topbar shrink-0 items-center gap-2 border-b border-divider bg-surface px-3">
          <NavigationProgress />
          {inSettings ? (
            <Link
              href={cameFrom.current}
              className="flex shrink-0 items-center gap-1 font-medium text-secondary no-underline hover:text-body"
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
              Back
            </Link>
          ) : (
            <>
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
              <Link href={homeHref} className="shrink-0 font-semibold tracking-tight text-cta no-underline md:hidden">
                Rawr
              </Link>
            </>
          )}

          {inSettings ? <h1 className="min-w-0 truncate font-medium">Settings</h1> : null}

          {search ? <div className="mx-auto w-full min-w-0 max-w-md">{search}</div> : null}

          <div className={cn('flex shrink-0 items-center gap-1', search ? '' : 'ml-auto')}>
            {create.length > 0 && !inSettings ? (
              <DropdownMenu
                label="Create"
                groups={[
                  {
                    key: 'create',
                    items: create.map((option) => {
                      const Icon = CREATE_ICONS[option.key] ?? Plus
                      return {
                        key: option.key,
                        label: option.label,
                        href: option.href,
                        icon: <Icon className="size-4" />,
                      }
                    }),
                  },
                ]}
                trigger={(props) => (
                  <IconButton {...props} label="Create" icon={<Plus className="size-5" />} tone="accent" />
                )}
              />
            ) : null}

            <DropdownMenu
              label="Help"
              groups={[
                {
                  key: 'help',
                  items: [
                    { key: 'agent', label: 'Connect an assistant', href: '/settings/agent' },
                    { key: 'account', label: 'Your account', href: accountHref },
                  ],
                },
              ]}
              trigger={(props) => (
                <IconButton {...props} label="Help" icon={<CircleHelp className="size-5" />} />
              )}
            />

            <NotificationBell workspaceSlug={workspaceSlug} />

            <IconButton
              label="Settings"
              tone={inSettings ? 'accent' : 'default'}
              icon={<Settings className="size-5" />}
              onClick={() => window.location.assign(settingsHref)}
            />

            <DropdownMenu
              label={`${email}, ${role}`}
              groups={[
                ...accountMenu,
                {
                  key: 'session',
                  items: [
                    {
                      key: 'sign-out',
                      label: 'Sign out',
                      icon: <LogOut className="size-4" />,
                      onSelect: () => {
                        const form = document.createElement('form')
                        form.method = 'post'
                        form.action = '/api/auth/sign-out'
                        document.body.append(form)
                        form.submit()
                      },
                    },
                  ],
                },
              ]}
              trigger={(props) => (
                <button
                  {...props}
                  type="button"
                  className="flex min-h-8 items-center gap-2 rounded-hs px-1 hover:bg-fill-hover"
                >
                  <Avatar name={email} size="sm" />
                  <span className="hidden min-w-0 max-w-40 truncate text-secondary lg:inline">
                    {workspaceName}
                  </span>
                </button>
              )}
            />
          </div>
        </header>

        {/* Phones: the same sections as a sheet over the content. */}
        {sheetOpen ? (
          <>
            <div id="primary-nav" className="fixed inset-y-0 left-0 z-overlay flex w-64 flex-col bg-nav text-nav-text md:hidden">
              <div className="flex h-topbar shrink-0 items-center justify-between gap-2 border-b border-nav-active/60 px-3">
                <span className="font-semibold tracking-tight">Rawr</span>
                <button
                  type="button"
                  aria-label="Close menu"
                  onClick={() => setSheetOpen(false)}
                  className="rounded-hs p-1.5 text-nav-muted hover:bg-nav-hover hover:text-nav-text"
                >
                  <X aria-hidden="true" className="size-5" />
                </button>
              </div>
              {sheet}
              <div className="flex flex-col gap-2 border-t border-nav-active/60 px-3 py-3 text-small text-nav-muted">
                <Link href={accountHref} className="truncate text-nav-muted no-underline hover:text-nav-text" title={email}>
                  {email} · {role}
                </Link>
                {workspaces.length > 1 ? (
                  <label className="flex items-center">
                    <span className="sr-only">Workspace</span>
                    <select
                      value={workspaceSlug}
                      onChange={(event) => switchTo(event.target.value)}
                      className="max-w-full min-h-8 truncate rounded-hs border border-nav-active bg-nav pl-2 pr-7 text-small text-nav-text"
                    >
                      {workspaces.map((option) => (
                        <option key={option.slug} value={option.slug}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <span className="truncate">{workspaceName}</span>
                )}
              </div>
            </div>
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setSheetOpen(false)}
              className="fixed inset-0 z-rail cursor-default bg-scrim md:hidden"
            />
          </>
        ) : null}

        {/* The page is a card on the canvas, the way HubSpot frames every screen.
            This is the one scrolling box on the page. */}
        <main
          aria-busy={pendingHref ? 'true' : undefined}
          className="relative flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto bg-canvas p-2 sm:p-4"
        >
          <div className="min-h-full min-w-0 rounded-panel border border-line bg-surface p-3 shadow-panel sm:p-6">
            {children}
          </div>
          {pendingHref ? (
            // The old screen stays put but steps back, and the spinner says the
            // new one is on its way. Replaced by the route's own loading state the
            // moment the server starts streaming it.
            <div className="pointer-events-none absolute inset-0 z-flyout flex items-start justify-center bg-canvas/60 pt-[20vh]">
              <Spinner size="lg" label="Opening" />
            </div>
          ) : null}
        </main>
      </div>
    </div>
  )
}
