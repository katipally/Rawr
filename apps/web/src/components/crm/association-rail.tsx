'use client'

import { Badge, Button, Card, IconButton, Select, TextInput, useToast } from '@rawr/ui'
import { ArrowDownUp, ExternalLink, Plus, Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { shortName } from '~/components/crm/value.tsx'
import { ACTION_ICONS } from '~/components/icons.ts'
import { encodeFilters, objectView, recordPath } from '~/lib/links.ts'
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
  account: string
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
  account,
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
  const [linkLabel, setLinkLabel] = useState('')
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
      setLinkLabel('')
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
            collapsible
            title={`${card.namePlural} (${card.total.toLocaleString()})`}
            action={
              canWrite && canLink ? (
                <>
                  {createFields[card.objectKey] ? (
                    <IconButton
                      label={`New ${card.nameSingular.toLowerCase()}`}
                      icon={<Plus aria-hidden="true" className="size-3.5" />}
                      className="size-6"
                      onClick={() => setCreating(card)}
                    />
                  ) : null}
                  <button
                    type="button"
                    aria-expanded={adding === card.objectKey}
                    onClick={() => {
                      setChoice(null)
                      setAdding(adding === card.objectKey ? null : card.objectKey)
                    }}
                    className="inline-flex h-6 items-center gap-1 rounded-pill px-2 text-small font-semibold hover:bg-fill"
                  >
                    <Plus aria-hidden="true" className="size-3" />
                    Add
                  </button>
                </>
              ) : null
            }
          >
            {searchable ? (
              <div className="flex items-center gap-1 px-6 pb-3">
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
                    className="h-control min-h-0 rounded-pill py-1 pl-8"
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
                    className="h-control min-h-0 w-auto rounded-pill py-1"
                  >
                    <option value="recent">Newest</option>
                    <option value="name">A to Z</option>
                  </Select>
                </label>
              </div>
            ) : null}

            {adding === card.objectKey && canLink ? (
              <div className="flex flex-col gap-2 px-6 pb-4">
                <RecordPicker
                  object={card.objectKey}
                  label={`Pick a ${card.nameSingular.toLowerCase()} to link`}
                  placeholder={`Search ${plural}`}
                  excludeId={card.objectKey === object ? recordId : null}
                  value={choice}
                  onChange={setChoice}
                />
                {/* What the link is, in the words of whoever made it. The column
                    and the badge on the row have been there since B8; nothing
                    ever wrote one. */}
                <TextInput
                  aria-label="What this link is, optional"
                  placeholder="Decision maker, Referred by…"
                  value={linkLabel}
                  maxLength={60}
                  onChange={(event) => setLinkLabel(event.target.value)}
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
                            label: linkLabel.trim() || null,
                          }),
                        'Linked.',
                      )
                    }}
                  >
                    Link
                  </Button>
                  <Button
                    variant="tertiary"
                    onClick={() => {
                      setAdding(null)
                      setLinkLabel('')
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}

            {rows.length === 0 ? (
              <p className="px-6 pb-6 text-center text-secondary">
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
              <ul className="flex flex-col gap-3 px-6 pb-4">
                {rows.map((row) => (
                  <li
                    key={`${row.objectKey}-${row.id}`}
                    className="flex items-start justify-between gap-2 rounded-panel border border-line px-3 py-3"
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <Link
                          href={recordPath(account, row.objectKey, row.id)}
                          title={row.displayName}
                          className="line-clamp-2 break-words"
                        >
                          {row.displayName}
                        </Link>
                        {row.isPrimary ? <Badge tone="ok">Primary</Badge> : null}
                      </span>
                      {row.detail ? (
                        <span className="block truncate text-secondary" title={row.detail}>
                          {row.detail}
                        </span>
                      ) : null}
                      {row.label ? <Badge tone="neutral">{row.label}</Badge> : null}
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
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {rows.length > 0 ? (
              <p className="px-6 pb-6">
                <Link
                  href={objectView(account, card.objectKey, 'all', 'list', {
                    filters: filterFor(object, recordId, card.objectKey),
                  })}
                  className="inline-flex items-center gap-1"
                >
                  {filterFor(object, recordId, card.objectKey)
                    ? `View all associated ${card.namePlural}`
                    : `View all ${card.namePlural}`}
                  <ExternalLink aria-hidden="true" className="size-3" />
                </Link>
                {rows.length < card.total ? <span className="ml-2 text-small text-secondary">Showing {rows.length} of {card.total}.</span> : null}
              </p>
            ) : null}
          </Card>
        )
      })}

      {creating && createFields[creating.objectKey] ? (
        <CreateRecordDialog
          account={account}
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

/** A company's contacts and deals point at it with a column, so the list can open
 *  filtered to exactly them. Every other pair is joined only by association rows,
 *  and `id` is not a field the filter language has, so there is nothing to filter
 *  on. The link then opens the plain list and says so, rather than promising
 *  "associated" and showing everything.
 *
 *  Wording, not a filter, because the alternative — putting every linked id in the
 *  query string — is a URL that grows with the data and breaks at some customer's
 *  proxy rather than in a test. */
const filterFor = (object: string, recordId: string, objectKey: string): string | undefined =>
  object === 'company' && (objectKey === 'contact' || objectKey === 'deal')
    ? encodeFilters([
        { conjunction: 'and', conditions: [{ field: 'company_id', operator: 'is', value: recordId }] },
      ])
    : undefined
