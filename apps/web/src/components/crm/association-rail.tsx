'use client'

import { Badge, Button, Card, IconButton, Select, TextInput, useToast } from '@rawr/ui'
import { ArrowDownUp, Plus, Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { CreateRecordDialog, type CreateField } from './create-record.tsx'
import { RecordPicker, type PickedRecord } from './record-picker.tsx'

export type Associated = {
  id: string
  objectKey: ObjectKey
  displayName: string
  detail: string | null
  isPrimary: boolean
  label: string | null
}

/** How many rows a card holds before searching it is worth offering. Below this
 *  the eye is faster than the box. */
const SEARCHABLE_FROM = 5

export type AssociationRailProps = {
  workspace: string
  object: ObjectKey
  recordId: string
  contacts: Associated[]
  companies: Associated[]
  deals: Associated[]
  /** Which objects can be linked from here, narrowed to the sensible pairs. The
   *  records themselves are searched, never listed: a deal's next contact is very
   *  rarely among the newest few hundred. */
  linkable: ObjectKey[]
  /** The create form for each linkable object, so a deal's new contact is made
   *  here and linked in one step rather than created elsewhere and searched for. */
  createFields: Partial<Record<ObjectKey, CreateField[]>>
  /** Prefilled onto a record created from here: a contact or deal made from a
   *  company page starts with that company as its primary. */
  createInitial: Record<string, unknown>
  canWrite: boolean
  /** How many are linked, before a search narrowed the rows. The badge counts
   *  these, so a search does not make a card look emptier than the record is. */
  totals: { contacts: number; companies: number; deals: number }
}

const TITLES: Record<ObjectKey, string> = {
  contact: 'Contacts',
  company: 'Companies',
  deal: 'Deals',
}

export const AssociationRail = ({
  workspace,
  object,
  recordId,
  contacts,
  companies,
  deals,
  linkable,
  createFields,
  createInitial,
  canWrite,
  totals,
}: AssociationRailProps) => {
  const router = useRouter()
  const toast = useToast()
  const [adding, setAdding] = useState<ObjectKey | null>(null)
  const [choice, setChoice] = useState<PickedRecord | null>(null)
  const [creating, setCreating] = useState<ObjectKey | null>(null)
  const [busy, setBusy] = useState(false)
  // Per card, because a person searching a company's contacts is not searching
  // its deals at the same time.
  const [needles, setNeedles] = useState<Partial<Record<ObjectKey, string>>>({})
  const [sorts, setSorts] = useState<Partial<Record<ObjectKey, 'recent' | 'name'>>>({})

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

  const sections: { key: ObjectKey; rows: Associated[]; total: number }[] = [
    { key: 'contact', rows: contacts, total: totals.contacts },
    { key: 'company', rows: companies, total: totals.companies },
    { key: 'deal', rows: deals, total: totals.deals },
  ]

  /** Over the rows already on the page. The rail is capped per object, and a card
   *  that says "12 of 340" is honest about what the box is filtering. */
  const shown = (key: ObjectKey, rows: Associated[]): Associated[] => {
    const needle = (needles[key] ?? '').trim().toLowerCase()
    const filtered = needle
      ? rows.filter(
          (row) =>
            row.displayName.toLowerCase().includes(needle) ||
            (row.detail?.toLowerCase().includes(needle) ?? false),
        )
      : rows
    return (sorts[key] ?? 'recent') === 'name'
      ? [...filtered].sort((a, b) => a.displayName.localeCompare(b.displayName))
      : filtered
  }

  return (
    <div className="flex flex-col gap-3">
      {sections.map((section) => {
        if (section.key === object && section.rows.length === 0) return null
        const canLink = linkable.includes(section.key)

        const rows = shown(section.key, section.rows)
        const searchable = section.rows.length >= SEARCHABLE_FROM
        const needle = needles[section.key] ?? ''

        return (
          <Card
            key={section.key}
            flush
            title={
              <span className="flex items-center gap-1.5">
                {TITLES[section.key]}
                <Badge tone="neutral">{section.total}</Badge>
              </span>
            }
            action={
              canWrite && canLink ? (
                <>
                  {createFields[section.key] ? (
                    <IconButton
                      label={`New ${section.key}`}
                      icon={<Plus aria-hidden="true" className="size-4" />}
                      onClick={() => setCreating(section.key)}
                    />
                  ) : null}
                  <Button
                    variant="tertiary"
                    aria-expanded={adding === section.key}
                    onClick={() => {
                      setChoice(null)
                      setAdding(adding === section.key ? null : section.key)
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
                    aria-label={`Search linked ${TITLES[section.key].toLowerCase()}`}
                    placeholder={`Search ${TITLES[section.key].toLowerCase()}`}
                    onChange={(event) =>
                      setNeedles({ ...needles, [section.key]: event.target.value })
                    }
                    className="pl-8"
                  />
                </span>
                <label className="flex shrink-0 items-center gap-1">
                  <ArrowDownUp aria-hidden="true" className="size-4 text-secondary" />
                  <span className="sr-only">Sort {TITLES[section.key].toLowerCase()}</span>
                  <Select
                    value={sorts[section.key] ?? 'recent'}
                    aria-label={`Sort ${TITLES[section.key].toLowerCase()}`}
                    onChange={(event) =>
                      setSorts({
                        ...sorts,
                        [section.key]: event.target.value === 'name' ? 'name' : 'recent',
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

            {adding === section.key && canLink ? (
              <div className="flex flex-col gap-2 border-b border-divider px-3 py-2">
                <RecordPicker
                  object={section.key}
                  label={`Pick a ${section.key} to link`}
                  placeholder={`Search ${TITLES[section.key].toLowerCase()}`}
                  excludeId={section.key === object ? recordId : null}
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
                      if (section.rows.some((row) => row.id === picked.id)) {
                        toast('info', `${picked.label} is already linked here.`)
                        return
                      }
                      void run(
                        () =>
                          api.crm.associations.add.mutate({
                            a: { entityType: object, entityId: recordId },
                            b: { entityType: section.key, entityId: picked.id },
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
                {section.rows.length === 0 ? (
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
                      <Link href={recordPath(workspace, row.objectKey, row.id)} className="block break-words">
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
                      <Button
                        variant="tertiary"
                        busy={busy}
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
                      >
                        Unlink
                      </Button>
                    ) : row.isPrimary ? (
                      <span className="shrink-0 text-small text-secondary">Primary</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {rows.length > 0 && rows.length < section.total ? (
              <p className="border-t border-divider px-3 py-2 text-small text-secondary">
                Showing {rows.length} of {section.total}.
              </p>
            ) : null}
          </Card>
        )
      })}

      {creating && createFields[creating] ? (
        <CreateRecordDialog
          workspace={workspace}
          object={creating}
          objectLabel={TITLES[creating].replace(/s$/, '').replace('Companie', 'Company')}
          fields={createFields[creating] ?? []}
          // A contact or deal made from a company already points at it through
          // company_id, so the link exists without an association row.
          initial={createInitial}
          onClose={() => setCreating(null)}
          onCreated={async (id) => {
            const already = object === 'company' && (creating === 'contact' || creating === 'deal')
            if (!already) {
              await api.crm.associations.add.mutate({
                a: { entityType: object, entityId: recordId },
                b: { entityType: creating, entityId: id },
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
