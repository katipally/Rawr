'use client'

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { cn } from '../cn.ts'
import { Popover } from './popover.tsx'
import type { Align, Side } from './position.ts'

export type MenuItem = {
  key: string
  label: ReactNode
  icon?: ReactNode
  /** A right-hand hint: a shortcut, a count, a current value. */
  hint?: ReactNode
  onSelect?: () => void
  href?: string
  disabled?: boolean
  destructive?: boolean
  /** Drawn as chosen, for menus that stand in for a radio group (theme, sort). */
  checked?: boolean
}

export type MenuGroup = { key: string; label?: string; items: MenuItem[] }

export type DropdownMenuProps = {
  /** The trigger. It gets the aria wiring and the ref, so pass a single element
   *  that forwards props: a Button or an IconButton. */
  trigger: (props: {
    ref: React.RefObject<HTMLButtonElement | null>
    onClick: () => void
    'aria-haspopup': 'menu'
    'aria-expanded': boolean
    'aria-controls': string
  }) => ReactNode
  groups: MenuGroup[]
  label: string
  side?: Side
  align?: Align
  className?: string
}

/** A menu of actions. Arrow keys walk it, Home and End jump, Escape closes and
 *  returns focus to the trigger; a link item is a real anchor so it can be
 *  opened in a new tab. */
export const DropdownMenu = ({
  trigger,
  groups,
  label,
  side = 'bottom',
  align = 'end',
  className,
}: DropdownMenuProps) => {
  const id = useId()
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const items = groups.flatMap((group) => group.items).filter((item) => !item.disabled)

  useEffect(() => {
    if (!open) return
    // First enabled item, once the panel exists.
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>('[data-menu-item]')?.focus())
  }, [open])

  const close = () => {
    setOpen(false)
    button.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const stops = [...(list.current?.querySelectorAll<HTMLElement>('[data-menu-item]') ?? [])]
    if (stops.length === 0) return
    const at = stops.indexOf(document.activeElement as HTMLElement)
    const go = (next: number) => {
      event.preventDefault()
      stops[(next + stops.length) % stops.length]?.focus()
    }
    if (event.key === 'ArrowDown') go(at + 1)
    else if (event.key === 'ArrowUp') go(at - 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(stops.length - 1)
    else if (event.key === 'Tab') close()
  }

  const row = (item: MenuItem) => {
    const body = (
      <>
        {item.icon ? <span className="flex size-4 shrink-0 items-center justify-center">{item.icon}</span> : null}
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {item.hint ? <span className="shrink-0 text-small text-secondary">{item.hint}</span> : null}
        {item.checked ? <span aria-hidden="true" className="shrink-0 text-link">✓</span> : null}
      </>
    )
    const face = cn(
      'flex w-full items-center gap-2 px-3 py-1.5 text-left no-underline',
      item.disabled
        ? 'cursor-not-allowed text-secondary opacity-60'
        : item.destructive
          ? 'text-error hover:bg-error-subtle focus-visible:bg-error-subtle'
          : 'text-body hover:bg-fill-hover focus-visible:bg-fill-hover',
      'focus-visible:outline-none',
    )

    if (item.href && !item.disabled) {
      return (
        <a
          key={item.key}
          href={item.href}
          role="menuitem"
          data-menu-item=""
          onClick={() => setOpen(false)}
          className={face}
        >
          {body}
        </a>
      )
    }
    const common = {
      type: 'button' as const,
      'aria-disabled': item.disabled || undefined,
      'data-menu-item': item.disabled ? undefined : '',
      disabled: item.disabled,
      onClick: () => {
        item.onSelect?.()
        close()
      },
      className: face,
    }

    // aria-checked belongs to a radio item and to nothing else, so the two cases
    // are two elements rather than one with a conditional role.
    // The key is passed directly rather than through the shared object: React
    // reads it before props and warns when it arrives by spread.
    return item.checked === undefined ? (
      <button key={item.key} {...common} role="menuitem">
        {body}
      </button>
    ) : (
      <button key={item.key} {...common} role="menuitemradio" aria-checked={item.checked}>
        {body}
      </button>
    )
  }

  return (
    <>
      {trigger({
        ref: button,
        onClick: () => setOpen((value) => !value),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
      })}
      <Popover
        open={open}
        onClose={close}
        anchorRef={button}
        side={side}
        align={align}
        label={label}
        className={cn('min-w-52 py-1', className)}
      >
        {/* The dialog wrapper owns focus and dismissal; this is the menu itself. */}
        <div ref={list} id={id} role="menu" aria-label={label} onKeyDown={onKeyDown}>
          {items.length === 0 ? <p className="px-3 py-2 text-secondary">Nothing here yet.</p> : null}
          {groups.map((group, index) => (
            // A run of menu items, not a set of form controls, so <fieldset>
            // would be the wrong element here.
            // biome-ignore lint/a11y/useSemanticElements: see above
            <div
              key={group.key}
              role="group"
              aria-label={group.label}
              className={cn(index > 0 && 'mt-1 border-t border-divider pt-1')}
            >
              {group.label ? (
                <p className="px-3 pt-1 pb-1 text-small font-medium uppercase tracking-wide text-secondary">
                  {group.label}
                </p>
              ) : null}
              {group.items.map(row)}
            </div>
          ))}
        </div>
      </Popover>
    </>
  )
}
