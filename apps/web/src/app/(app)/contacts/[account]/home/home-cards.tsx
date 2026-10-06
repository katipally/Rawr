'use client'

import { cn, DropdownMenu } from '@rawr/ui'
import { GripVertical, MoreVertical } from 'lucide-react'
import Link from 'next/link'
import { type ReactNode, useState } from 'react'
import { useUi, useUiReady } from '~/lib/store/ui.ts'

export type HomeCard = {
  key: string
  title: string
  /** The list the card is a window onto: its title opens it. */
  href: string
  /** What More actions calls that list. */
  hrefLabel: string
  body: ReactNode
}

/** Shown while the pointer is over the card or something in it has focus, and
 *  always where there is no hover to show it with. */
const onHover = 'opacity-0 transition-opacity duration-150 ease-out group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(hover:none)]:opacity-100'

/** The saved order first, then any card it does not name in its default place
 *  after them. O(cards). */
const arrange = (cards: HomeCard[], saved: string[]): HomeCard[] => {
  const byKey = new Map(cards.map((card) => [card.key, card]))
  const placed = saved.flatMap((key) => byKey.get(key) ?? [])
  const named = new Set(saved)
  return [...placed, ...cards.filter((card) => !named.has(card.key))]
}

/** Home's cards in HubSpot's tile, which a person rearranges for themselves by
 *  dragging one by its grip onto another, or from its More actions menu. */
export const HomeCards = ({ cards }: { cards: HomeCard[] }) => {
  const ready = useUiReady()
  const saved = useUi((state) => state.homeCards)
  const setHomeCards = useUi((state) => state.setHomeCards)
  const [dragging, setDragging] = useState<string | null>(null)
  // The server draws the default order; a saved one replaces it once it is known.
  const shown = ready ? arrange(cards, saved) : cards

  /** Saves the visible order, keeping the place of cards this person cannot see
   *  today (a hub they lost) so it comes back if the hub does. */
  const place = (keys: string[]) => {
    const visible = new Set(keys)
    setHomeCards([...keys, ...saved.filter((key) => !visible.has(key))])
  }

  const moveTo = (key: string, index: number) => {
    const keys = shown.map((card) => card.key).filter((each) => each !== key)
    keys.splice(index, 0, key)
    place(keys)
  }

  return (
    <div className="grid gap-2.5 @3xl:grid-cols-2">
      {shown.map((card, index) => (
        <section
          key={card.key}
          aria-label={card.title}
          onDragOver={dragging ? (event) => event.preventDefault() : undefined}
          onDrop={
            dragging
              ? (event) => {
                  event.preventDefault()
                  if (dragging !== card.key) moveTo(dragging, index)
                  setDragging(null)
                }
              : undefined
          }
          className={cn(
            'group/card relative flex min-w-0 flex-col gap-3 rounded-panel border border-line bg-surface p-3 transition-[border-color,box-shadow,opacity] duration-150 ease-out hover:border-line-strong hover:shadow-side motion-reduce:transition-none',
            dragging === card.key && 'opacity-60',
          )}
        >
          <header className="flex min-w-0 items-start gap-1">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: the grip is the pointer's shortcut; More actions moves a card from the keyboard */}
            <span
              draggable
              onDragStart={(event) => {
                setDragging(card.key)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragEnd={() => setDragging(null)}
              title="Drag to move"
              className={cn('absolute top-4 left-0 flex cursor-grab text-secondary', onHover)}
            >
              <GripVertical aria-hidden="true" className="size-3" />
            </span>
            <Link href={card.href} className="min-w-0 flex-1 break-words text-base font-semibold">
              {card.title}
            </Link>
            <DropdownMenu
              label={`More actions for ${card.title}`}
              groups={[
                { key: 'go', items: [{ key: 'go', label: card.hrefLabel, href: card.href }] },
                {
                  key: 'move',
                  items: [
                    { key: 'up', label: 'Move up', disabled: index === 0, onSelect: () => moveTo(card.key, index - 1) },
                    { key: 'down', label: 'Move down', disabled: index === shown.length - 1, onSelect: () => moveTo(card.key, index + 1) },
                  ],
                },
              ]}
              trigger={(props) => (
                <button
                  {...props}
                  type="button"
                  aria-label={`More actions for ${card.title}`}
                  className={cn('flex size-6 shrink-0 items-center justify-center rounded-pill text-body hover:bg-fill', onHover)}
                >
                  <MoreVertical aria-hidden="true" className="size-4" />
                </button>
              )}
            />
          </header>
          <div className="min-w-0">{card.body}</div>
        </section>
      ))}
    </div>
  )
}
