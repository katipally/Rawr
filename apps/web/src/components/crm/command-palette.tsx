'use client'

import { Search } from 'lucide-react'
import { cn, filterOptions } from '@rawr/ui'
import { useNavigation } from '~/components/navigation.tsx'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { recordPath, tasksPath } from '~/lib/links.ts'
import { useUi, useUiReady } from '~/lib/store/ui.ts'

type Item = { key: string; label: string; detail: string | null; href: string }
type Group = { label: string; items: Item[] }

/** A page the rail or Settings can reach, so the box finds pages as well as
 *  records. Passed down from the same lists those two are built from, so the
 *  three cannot drift: a page added to either is searchable the same day.
 *
 *  `keywords` carry the words somebody actually types. "billing" and "users" are
 *  not our labels, and a search that finds nothing for them reads as a missing
 *  feature rather than a missing synonym. */
export type Page = { label: string; section: string; href: string; keywords?: string[] }

/** A verb rather than a place: "Create contact", "Import records". Every one is
 *  a plain href, so an action is a navigation with a name somebody would say. */
export type Action = { label: string; href: string; keywords?: string[] }

const DEBOUNCE_MS = 180

/** More than this and the list is a rail with extra steps. */
const MAX_PAGES = 8
const MAX_ACTIONS = 5


export const CommandPalette = ({
  account,
  pages,
  actions,
}: {
  account: string
  pages: Page[]
  actions: Action[]
}) => {
  const { navigate } = useNavigation()
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
  // Where somebody went last, from the store the rest of this browser's
  // preferences live in, so it is already right when the box opens rather than
  // re-read on every focus and click.
  const stored = useUi((state) => state.recent)
  const remember = useUi((state) => state.remember)
  const ready = useUiReady()
  const recent: Item[] = ready ? stored.map((row) => ({ key: row.href, detail: null, ...row })) : []
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        input.current?.focus()
        input.current?.select()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const term = text.trim()
    if (term.length < 2) {
      setGroups([])
      setError(null)
      return
    }
    // One request per pause in typing, and a stale response never overwrites a
    // newer one.
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      api.crm.search.query({ query: term })
        .then((results) => {
          if (cancelled) return
          setError(null)
          // Whatever the account has, named by the registry, so an object an
          // admin invented is searched from here the day it exists.
          setGroups(
            results.groups.map((group) => ({
              label: group.namePlural,
              items: group.hits.map((hit) => ({
                key: hit.id,
                label: hit.displayName,
                detail: hit.detail,
                // A task and an activity live on a record's page rather than one
                // of their own, so both open the record they name. A task on
                // nothing has only the task list.
                href: hit.parent
                  ? recordPath(account, hit.parent.objectKey, hit.parent.id)
                  : hit.objectKey === 'task'
                    ? tasksPath(account, { q: hit.displayName })
                    : recordPath(account, hit.objectKey, hit.id),
              })),
            })),
          )
          setActive(0)
        })
        .catch((cause: unknown) => {
          if (cancelled) return
          setGroups([])
          setError(errorMessage(cause))
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [text, account])

  // The rail and Settings both reach a handful of the same pages under different
  // names: "Data Model" is /settings/objects, "Properties" is in both lists. One
  // entry each, keeping the name the rail uses and the words Settings added to it,
  // so the panel never offers the same page twice and no two rows share a key.
  const unique = useMemo(() => {
    const byHref = new Map<string, Page>()
    for (const page of pages) {
      const seen = byHref.get(page.href)
      if (!seen) byHref.set(page.href, page)
      else if (page.keywords) byHref.set(page.href, { ...seen, keywords: [...(seen.keywords ?? []), page.label, ...page.keywords] })
    }
    return [...byHref.values()]
  }, [pages])

  // Pages and actions are matched here rather than on the server: both lists are
  // already in memory, and neither match should wait for a round trip.
  const term = text.trim()
  const local: Group[] =
    term.length < 2
      ? []
      : [
          {
            label: 'Actions',
            items: filterOptions(actions, term)
              .slice(0, MAX_ACTIONS)
              .map((action) => ({ key: action.href, label: action.label, detail: null, href: action.href })),
          },
          {
            label: 'Go to',
            items: filterOptions(
              unique.map((page) => ({ ...page, hint: page.section })),
              term,
            )
              .slice(0, MAX_PAGES)
              .map((page) => ({ key: page.href, label: page.label, detail: page.section, href: page.href })),
          },
        ].filter((group) => group.items.length > 0)

  // An empty box is not a dead box: what somebody opened last, then what they can
  // make, which is the whole reason to press the shortcut before typing.
  const resting: Group[] =
    term.length >= 2
      ? []
      : [
          { label: 'Recent', items: recent },
          {
            label: 'Actions',
            items: actions
              .slice(0, MAX_ACTIONS)
              .map((action) => ({ key: action.href, label: action.label, detail: null, href: action.href })),
          },
        ].filter((group) => group.items.length > 0)

  const shown = term.length >= 2 ? [...local, ...groups] : resting
  const flat = shown.flatMap((group) => group.items)

  const go = (item: Item) => {
    setOpen(false)
    setText('')
    setGroups([])
    remember({ href: item.href, label: item.label })
    navigate(item.href)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((current) => Math.min(current + 1, Math.max(flat.length - 1, 0)))
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => Math.max(current - 1, 0))
    }
    if (event.key === 'Enter') {
      const item = flat[active]
      if (item) {
        event.preventDefault()
        go(item)
      }
    }
    if (event.key === 'Escape') {
      setOpen(false)
      input.current?.blur()
    }
  }

  const showing = open && flat.length + (term.length >= 2 ? 1 : 0) > 0
  let index = -1

  return (
    <div className="relative min-w-0">
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-nav-text" />
      <input
        ref={input}
        type="search"
        value={text}
        role="combobox"
        aria-expanded={showing}
        aria-controls={listId}
        aria-label="Search Rawr"
        placeholder="Search"
        onChange={(event) => {
          setText(event.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          setActive(0)
          setOpen(true)
        }}
        onClick={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        className="h-8 w-full min-w-0 rounded-pill border border-nav-line bg-nav pl-4 pr-10 text-nav-text placeholder:text-nav-text outline-none focus:border-nav-text"
      />

      {showing ? (
        <div
          id={listId}
          role="listbox"
          // text-body is not decoration: this panel hangs off an input in the
          // charcoal top bar, so without it every unstyled label inherits that
          // bar's near-white ink and renders white on white.
          className="absolute top-full right-0 left-0 z-40 mt-1 max-h-[70vh] overflow-y-auto rounded-panel border border-line bg-surface text-body shadow-overlay"
        >
          {error ? (
            <p role="alert" className="px-3 py-2 text-error">
              {error}
            </p>
          ) : flat.length === 0 ? (
            <p className="px-3 py-2 text-secondary">
              {searching ? 'Searching…' : `Nothing matches “${term}”.`}
            </p>
          ) : (
            shown.map((group) => (
              <div key={group.label}>
                <p className="bg-fill px-3 py-1 text-small font-medium text-secondary uppercase">
                  {group.label}
                </p>
                <ul>
                  {group.items.map((item) => {
                    index += 1
                    const current = index
                    return (
                      <li key={item.key}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={current === active}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => go(item)}
                          onMouseEnter={() => setActive(current)}
                          className={cn(
                            'block w-full px-3 py-1.5 text-left',
                            current === active && 'bg-accent-subtle',
                          )}
                        >
                          <span className="block truncate font-medium">{item.label}</span>
                          {item.detail ? (
                            <span className="block truncate text-secondary">{item.detail}</span>
                          ) : null}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}
