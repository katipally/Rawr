'use client'

import { cn, filterOptions } from '@rawr/ui'
import { ChevronDown, ChevronLeft, ChevronUp, Search } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Fragment, useId, useState, type ReactNode } from 'react'
import type { SettingsGroup, SettingsSection } from '~/lib/settings-nav.ts'
import { useBeforeSettings } from '~/lib/use-origin.ts'

/** HubSpot's rail item: 38 tall, 14/300, radius 6, hung 12px left of the group
 *  label so the text lines up under it. */
const item = 'relative -ml-3 flex w-[calc(100%+0.75rem)] items-center gap-2 rounded-hs py-[0.4375rem] pr-3 text-left font-light text-body no-underline transition-colors duration-150 ease-out'

/** The query string on a properties link picks an object, not a page, so the
 *  comparison is on the path alone. */
const pathOf = (href: string) => href.split('?')[0] ?? href

/** The match in bold, as HubSpot's results draw it. */
const Highlight = ({ text, needle }: { text: string; needle: string }): ReactNode => {
  const at = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <strong className="font-semibold">{text.slice(at, at + needle.length)}</strong>
      {text.slice(at + needle.length)}
    </>
  )
}

/** Labels only. Every settings page opens with its own title and a sentence
 *  saying what it is for, so repeating that sentence sixteen times in the rail
 *  made a list of sixteen names into a wall of prose nobody reads.
 *
 *  Search is HubSpot's: typing opens a list of matching settings under the box,
 *  keywords included, and the rail itself stays whole. */
export const SettingsNav = ({ groups, backHref }: { groups: SettingsGroup[]; backHref: string }) => {
  const pathname = usePathname()
  const router = useRouter()
  const listId = useId()
  const [needle, setNeedle] = useState('')
  const [active, setActive] = useState(0)
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const back = useBeforeSettings(backHref)

  const isCurrent = (section: SettingsSection) =>
    [section.href, ...(section.also ?? [])].some((href) => pathname.startsWith(pathOf(href)))

  const wanted = needle.trim()
  const results = wanted
    ? filterOptions(
        groups.flatMap((group) => group.sections.map((section) => ({ ...section, group: group.label }))),
        wanted,
      )
    : []
  const open = wanted !== ''

  const go = (href: string) => {
    setNeedle('')
    router.push(href)
  }

  const link = (section: SettingsSection, nested: boolean) => {
    const current = isCurrent(section)
    return (
      <li key={section.href}>
        <Link
          href={section.href}
          aria-current={current ? 'page' : undefined}
          className={cn(
            item,
            nested ? 'pl-6' : 'pl-3',
            current ? 'bg-canvas before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-body' : 'hover:bg-fill',
          )}
        >
          <span className="min-w-0 truncate">{section.label}</span>
        </Link>
      </li>
    )
  }

  return (
    <nav aria-label="Settings" className="min-w-0">
      <div className="relative flex flex-col gap-4 border-b border-line px-6 pt-5 pb-6">
        <Link href={back} className="flex items-center gap-1 self-start text-small font-semibold text-body no-underline hover:underline">
          <ChevronLeft aria-hidden="true" className="size-4" />
          Back
        </Link>
        <label className="relative block">
          <span className="sr-only">Search settings</span>
          <input
            type="search"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
            value={needle}
            onChange={(event) => {
              setNeedle(event.target.value)
              setActive(0)
            }}
            onKeyDown={(event) => {
              if (!open) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setActive((at) => (results.length === 0 ? 0 : (at + step + results.length) % results.length))
              } else if (event.key === 'Enter' && results[active]) {
                event.preventDefault()
                go(results[active].href)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                setNeedle('')
              }
            }}
            placeholder="Search Settings"
            className="h-10 w-full rounded-pill border border-line-strong bg-surface pr-10 pl-4 text-base font-light outline-none focus:border-body"
          />
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2" />
        </label>
        {open ? (
          <div
            id={listId}
            role="listbox"
            aria-label="Matching settings"
            className="absolute inset-x-2 top-full z-flyout -mt-4 flex max-h-[min(28rem,60dvh)] animate-pop-in flex-col overflow-y-auto rounded-hs bg-surface py-1 shadow-overlay motion-reduce:animate-none"
          >
            {results.length === 0 ? (
              <p className="px-4 py-3 text-secondary">No settings match {`"${wanted}"`}.</p>
            ) : (
              results.map((result, index) => (
                <div
                  key={result.href}
                  id={`${listId}-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  // Mouse down, not click: the input must not blur first.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    go(result.href)
                  }}
                  className={cn('flex cursor-pointer flex-col px-4 py-2', index === active && 'bg-fill')}
                >
                  <span className="truncate">
                    <Highlight text={result.label} needle={wanted} />
                  </span>
                  <span className="truncate text-small text-secondary">
                    Setting · {result.parent ?? result.group}
                  </span>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
      <ul className="flex flex-col gap-8 py-6 pr-6 pl-8">
        {groups.map((group) => (
          <li key={group.label}>
            <h2 className="mb-2 text-base font-semibold">{group.label}</h2>
            <ul className="flex flex-col">
              {group.sections.map((section, index) => {
                if (!section.parent) return link(section, false)
                if (group.sections[index - 1]?.parent === section.parent) return null
                const parent = section.parent
                const children = group.sections.filter((each) => each.parent === parent)
                // Open while one of its pages is on screen, until the person says otherwise.
                const expanded = folded[parent] ?? children.some(isCurrent)
                return (
                  <Fragment key={parent}>
                    <li>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setFolded((current) => ({ ...current, [parent]: !expanded }))}
                        className={cn(item, 'pl-3 hover:bg-fill')}
                      >
                        <span className="min-w-0 flex-1 truncate">{parent}</span>
                        {expanded ? (
                          <ChevronUp aria-hidden="true" className="size-4 shrink-0" />
                        ) : (
                          <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
                        )}
                      </button>
                    </li>
                    {expanded ? children.map((child) => link(child, true)) : null}
                  </Fragment>
                )
              })}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  )
}
