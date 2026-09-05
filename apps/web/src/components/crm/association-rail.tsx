'use client'

import { Badge, Button, Card, IconButton, Select, TextInput, useToast } from '@rawr/ui'
import { ArrowDownUp, Plus, Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { shortName } from '~/components/crm/value.tsx'
import { ACTION_ICONS } from '~/components/icons.ts'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { CreateRecordDialog, type CreateField } from './create-record.tsx'
import { RecordPicker, type PickedRecord } from './record-picker.tsx'

export type Associated = {
  id: string
  objectKey: string
  displayName: string
  detail: string | null
  isPrimary: boolean
  label: string | null
}

/** One card: everything of one object that is linked to this record. Named by the
 *  registry, so an object an admin invented gets a card that reads like the rest. */
export type AssociationCard = {
  objectKey: string
  nameSingular: string
  namePlural: string
  records: Associated[]
  /** How many are linked, before a search narrowed the rows. The badge counts
   *  these, so a search does not make a card look emptier than the record is. */
  total: number
}

/** How many rows a card holds before searching it is worth offering. Below this
 *  the eye is faster than the box. */
const SEARCHABLE_FROM = 5

export type AssociationRailProps = {
  workspace: string
  object: string
  recordId: string
  cards: AssociationCard[]
  /** Which objects can be linked from here. The records themselves are searched,
   *  never listed: a deal's next contact is very rarely among the newest few
   *  hundred. */
  linkable: string[]
  /** The create form for each linkable object, so a deal's new contact is made
   *  here and linked in one step rather than created elsewhere and searched for. */
  createFields: Record<string, CreateField[]>
  /** Prefilled onto a record created from here: a contact or deal made from a
   *  company page starts with that company as its primary. */
  createInitial: Record<string, unknown>
  canWrite: boolean
}

export const AssociationRail = ({
  workspace,
  object,
  recordId,
  cards,
  linkable,
  createFields,
  createInitial,
  canWrite,
}: AssociationRailProps) => {
  const router = useRouter()
  const toast = useToast()
  const [adding, setAdding] = useState<string | null>(null)
  const [choice, setChoice] = useState<PickedRecord | null>(null)
  const [creating, setCreating] = useState<AssociationCard | null>(null)
  const [busy, setBusy] = useState(false)
  // Per card, because a person searching a company's contacts is not searching
  // its deals at the same time.
  const [needles, setNeedles] = useState<Record<string, string>>({})
  const [sorts, setSorts] = useState<Record<string, 'recent' | 'name'>>({})

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast('success', done)
      setAdding(null)
      setChoice(null)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  /** Over the rows already on the page. The rail is capped per object, and a card
   *  that says "12 of 340" is honest about what the box is filtering. */
  const shown = (card: AssociationCard): Associated[] => {
    const needle = (needles[card.objectKey] ?? '').trim().toLowerCase()
    const filtered = needle
      ? card.records.filter(
          (row) =>
            row.displayName.toLowerCase().includes(needle) ||
            (row.detail?.toLowerCase().includes(needle) ?? false),
        )
      : card.records
    return (sorts[card.objectKey] ?? 'recent') === 'name'
      ? [...filtered].sort((a, b) => a.displayName.localeCompare(b.displayName))
      : filtered
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map((card) => {
        const canLink = linkable.includes(card.objectKey)
        const rows = shown(card)
        const searchable = card.records.length >= SEARCHABLE_FROM
        const needle = needles[card.objectKey] ?? ''
        const plural = card.namePlural.toLowerCase()

        return (
          <Card
            key={card.objectKey}
            flush
            title={
              <span className="flex items-center gap-1.5">
                {card.namePlural}
                <Badge tone="neutral">{card.total}</Badge>
              </span>
            }
            action={
              canWrite && canLink ? (
                <>
                  {createFields[card.objectKey] ? (
                    <IconButton
                      label={`New ${card.nameSingular.toLowerCase()}`}
                      icon={<Plus aria-hidden="true" className="size-4" />}
                      onClick={() => setCreating(card)}
                    />
                  ) : null}
                  <Button
                    variant="tertiary"
                    aria-expanded={adding === card.objectKey}
                    onClick={() => {
                      setChoice(null)
                      setAdding(adding === card.objectKey ? null : card.objectKey)
                    }}
                  >
                    Add
                  </Button>
                </>
              ) : null
            }
          >
            {searchable ? (
              <div className="flex items-center gap-1 border-b border-divider px-3 py-2">
                <span className="relative flex min-w-0 flex-1 items-center">
                  <Search aria-hidden="true" className="absolute left-2 size-4 text-secondary" />
                  <TextInput
                    type="search"
                    value={needle}
                    aria-label={`Search linked ${plural}`}
                    placeholder={`Search ${plural}`}
                    onChange={(event) =>
                      setNeedles({ ...needles, [card.objectKey]: event.target.value })
                    }
                    className="pl-8"
                  />
                </span>
                <label className="flex shrink-0 items-center gap-1">
                  <ArrowDownUp aria-hidden="true" className="size-4 text-secondary" />
                  <span className="sr-only">Sort {plural}</span>
                  <Select
                    value={sorts[card.objectKey] ?? 'recent'}
                    aria-label={`Sort ${plural}`}
                    onChange={(event) =>
                      setSorts({
                        ...sorts,
                        [card.objectKey]: event.target.value === 'name' ? 'name' : 'recent',
                      })
                    }
                    className="w-auto"
                  >
                    <option value="recent">Newest</option>
                    <option value="name">A to Z</option>
                  </Select>
                </label>
              </div>
            ) : null}

            {adding === card.objectKey && canLink ? (
              <div className="flex flex-col gap-2 border-b border-divider px-3 py-2">
                <RecordPicker
                  object={card.objectKey}
                  label={`Pick a ${card.nameSingular.toLowerCase()} to link`}
                  placeholder={`Search ${plural}`}
                  excludeId={card.objectKey === object ? recordId : null}
                  value={choice}
                  onChange={setChoice}
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    busy={busy}
                    disabled={choice === null}
                    onClick={() => {
                      const picked = choice
                      if (!picked) return
                      if (card.records.some((row) => row.id === picked.id)) {
                        toast('info', `${picked.label} is already linked here.`)
                        return
                      }
                      void run(
                        () =>
                          api.crm.associations.add.mutate({
                            a: { entityType: object, entityId: recordId },
                            b: { entityType: card.objectKey, entityId: picked.id },
                            label: null,
                          }),
                        'Linked.',
                      )
                    }}
                  >
                    Link
                  </Button>
                  <Button variant="tertiary" onClick={() => setAdding(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {rows.length === 0 ? (
              <p className="px-3 py-3 text-secondary">
                {card.records.length === 0 ? (
                  <>
                    Nothing linked yet.{' '}
                    {canWrite && canLink
                      ? 'Use Add to connect one.'
                      : 'A link appears here when one is made.'}
                  </>
                ) : (
                  <>Nothing here matches “{needle}”.</>
                )}
              </p>
            ) : (
              <ul className="flex flex-col">
                {rows.map((row) => (
                  <li
                    key={`${row.objectKey}-${row.id}`}
                    className="flex items-start justify-between gap-2 border-b border-divider px-3 py-2 last:border-0"
                  >
                    <span className="min-w-0">
                      <Link
                        href={recordPath(workspace, row.objectKey, row.id)}
                        title={row.displayName}
                        className="line-clamp-2 break-words"
                      >
                        {row.displayName}
                      </Link>
                      {row.detail ? (
                        <span className="block truncate text-secondary" title={row.detail}>
                          {row.detail}
                        </span>
                      ) : null}
                      {row.label ? <span className="text-small text-secondary">{row.label}</span> : null}
                    </span>

                    {canWrite && !row.isPrimary ? (
                      <IconButton
                        label={`Unlink ${shortName(row.displayName)}`}
                        icon={<ACTION_ICONS.unlink size={16} />}
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              api.crm.associations.remove.mutate({
                                a: { entityType: object, entityId: recordId },
                                b: { entityType: row.objectKey, entityId: row.id },
                              }),
                            'Unlinked.',
                          )
                        }
                      />
                    ) : row.isPrimary ? (
                      <span className="shrink-0 text-small text-secondary">Primary</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {rows.length > 0 && rows.length < card.total ? (
              <p className="border-t border-divider px-3 py-2 text-small text-secondary">
                Showing {rows.length} of {card.total}.
              </p>
            ) : null}
          </Card>
        )
      })}

      {creating && createFields[creating.objectKey] ? (
        <CreateRecordDialog
          workspace={workspace}
          object={creating.objectKey}
          objectLabel={creating.nameSingular}
          fields={createFields[creating.objectKey] ?? []}
          // A contact or deal made from a company already points at it through
          // company_id, so the link exists without an association row.
          initial={createInitial}
          onClose={() => setCreating(null)}
          onCreated={async (id) => {
            const target = creating.objectKey
            const already = object === 'company' && (target === 'contact' || target === 'deal')
            if (!already) {
              await api.crm.associations.add.mutate({
                a: { entityType: object, entityId: recordId },
                b: { entityType: target, entityId: id },
                label: null,
              })
            }
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}
