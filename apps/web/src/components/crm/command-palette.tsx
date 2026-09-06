'use client'

import { Search } from 'lucide-react'
import { cn } from '@rawr/ui'
import { useNavigation } from '~/components/navigation.tsx'
import { useEffect, useId, useRef, useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { recordPath } from '~/lib/links.ts'

type Hit = { objectKey: string; id: string; displayName: string; detail: string | null }
type Group = { label: string; hits: Hit[] }

const DEBOUNCE_MS = 180

export const CommandPalette = ({ workspace }: { workspace: string }) => {
  const { navigate } = useNavigation()
  const listId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [groups, setGroups] = useState<Group[]>([])
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
          // Whatever the workspace has, named by the registry, so an object an
          // admin invented is searched from here the day it exists.
          setGroups(results.groups.map((group) => ({ label: group.namePlural, hits: group.hits })))
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
  }, [text])

  const flat = groups.flatMap((group) => group.hits)

  const go = (hit: Hit) => {
    setOpen(false)
    setText('')
    setGroups([])
    navigate(recordPath(workspace, hit.objectKey, hit.id))
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
      const hit = flat[active]
      if (hit) {
        event.preventDefault()
        go(hit)
      }
    }
    if (event.key === 'Escape') {
      setOpen(false)
      input.current?.blur()
    }
  }

  const showing = open && text.trim().length >= 2
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
        aria-label="Search records"
        placeholder="Find or Ask"
        onChange={(event) => {
          setText(event.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        className="h-8 w-full min-w-0 rounded-pill border border-nav-line bg-nav pl-4 pr-10 text-nav-text placeholder:text-nav-text outline-none focus:border-nav-text"
      />

      {showing ? (
        <div
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-0 z-40 mt-1 max-h-[70vh] overflow-y-auto rounded-panel border border-line bg-surface shadow-overlay"
        >
          {error ? (
            <p role="alert" className="px-3 py-2 text-error">
              {error}
            </p>
          ) : flat.length === 0 ? (
            <p className="px-3 py-2 text-secondary">
              {searching ? 'Searching…' : `Nothing matches “${text.trim()}”.`}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <p className="bg-fill px-3 py-1 text-small font-medium text-secondary uppercase">
                  {group.label}
                </p>
                <ul>
                  {group.hits.map((hit) => {
                    index += 1
                    const current = index
                    return (
                      <li key={hit.id}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={current === active}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => go(hit)}
                          onMouseEnter={() => setActive(current)}
                          className={cn(
                            'block w-full px-3 py-1.5 text-left',
                            current === active && 'bg-accent-subtle',
                          )}
                        >
                          <span className="block truncate font-medium">{hit.displayName}</span>
                          {hit.detail ? (
                            <span className="block truncate text-secondary">{hit.detail}</span>
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
