'use client'

import { Button, Checkbox, Field, Modal, Switch, TextInput } from '@rawr/ui'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { useState } from 'react'

export type CardChoice = { key: string; label: string; group: string; report: string }

export type CardPickerProps = {
  open: boolean
  busy: boolean
  title: string
  catalogue: CardChoice[]
  initial: { name: string; cards: string[]; isShared: boolean }
  onClose: () => void
  onSave: (input: { name: string; cards: string[]; isShared: boolean }) => void
}

/** Choosing what goes on a dashboard, and in what order.
 *
 *  Two lists rather than a canvas: what is on it, in the order it will draw, and
 *  everything else grouped by the report it comes from. Dragging a card around a
 *  grid is the version of this that needs a pointer, and the order is the only
 *  layout decision a dashboard actually has. */
export const CardPicker = ({
  open,
  busy,
  title,
  catalogue,
  initial,
  onClose,
  onSave,
}: CardPickerProps) => {
  const [name, setName] = useState(initial.name)
  const [cards, setCards] = useState<string[]>(initial.cards)
  const [isShared, setIsShared] = useState(initial.isShared)

  // Reset on the render where the modal opens, so a cancelled edit does not leak
  // into the next one. Not an effect: `initial` is built inline by the caller and
  // is a new object every render, so an effect watching it would reset the form
  // under somebody's fingers.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setName(initial.name)
      setCards(initial.cards)
      setIsShared(initial.isShared)
    }
  }

  const labelOf = (key: string) => catalogue.find((card) => card.key === key)?.label ?? key

  const move = (index: number, by: number) => {
    const to = index + by
    if (to < 0 || to >= cards.length) return
    const next = [...cards]
    const [moved] = next.splice(index, 1)
    if (moved) next.splice(to, 0, moved)
    setCards(next)
  }

  const groups = [...new Set(catalogue.map((card) => card.group))]

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={title}
      footer={
        <div className="flex gap-2">
          <Button
            variant="primary"
            busy={busy}
            disabled={!name.trim() || cards.length === 0}
            onClick={() => onSave({ name: name.trim(), cards, isShared })}
          >
            Save
          </Button>
          <Button onClick={onClose}>Cancel</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Field id="dashboard-name" label="Name">
          <TextInput id="dashboard-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>

        <Switch
          label="Everybody in the workspace can see it"
          checked={isShared}
          onChange={(event) => setIsShared(event.target.checked)}
        />

        {groups.map((group) => (
          <fieldset key={group} className="min-w-0">
            <legend className="text-xs font-medium uppercase tracking-wide text-secondary">
              {group}
            </legend>
            <div className="mt-1 flex flex-col gap-1">
              {catalogue
                .filter((card) => card.group === group)
                .map((card) => (
                  <Checkbox
                    key={card.key}
                    label={card.label}
                    checked={cards.includes(card.key)}
                    onChange={(event) =>
                      setCards(
                        event.target.checked
                          ? [...cards, card.key]
                          : cards.filter((candidate) => candidate !== card.key),
                      )
                    }
                  />
                ))}
            </div>
          </fieldset>
        ))}
        {/* Below the catalogue, not above it: the chosen list grows as you tick,
            and above the catalogue that growth pushes the next checkbox out from
            under the pointer. */}
        <div>
          <h3 className="mb-1 font-medium">
            On this dashboard {cards.length > 0 ? `(${cards.length})` : ''}
          </h3>
          {cards.length === 0 ? (
            <p className="text-secondary">Nothing yet. Tick a card above.</p>
          ) : (
            <ol className="flex flex-col gap-1">
              {cards.map((key, index) => (
                <li
                  key={key}
                  className="flex items-center gap-2 rounded-hs border border-line px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate">{labelOf(key)}</span>
                  <Button
                    variant="tertiary"
                    aria-label={`Move ${labelOf(key)} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp aria-hidden="true" className="size-4" />
                  </Button>
                  <Button
                    variant="tertiary"
                    aria-label={`Move ${labelOf(key)} down`}
                    disabled={index === cards.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown aria-hidden="true" className="size-4" />
                  </Button>
                  <Button
                    variant="tertiary"
                    aria-label={`Remove ${labelOf(key)}`}
                    onClick={() => setCards(cards.filter((candidate) => candidate !== key))}
                  >
                    <X aria-hidden="true" className="size-4" />
                  </Button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Modal>
  )
}
