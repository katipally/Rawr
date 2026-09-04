'use client'

import { Button, useToast } from '@rawr/ui'
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
}: AssociationRailProps) => {
  const router = useRouter()
  const toast = useToast()
  const [adding, setAdding] = useState<ObjectKey | null>(null)
  const [choice, setChoice] = useState<PickedRecord | null>(null)
  const [creating, setCreating] = useState<ObjectKey | null>(null)
  const [busy, setBusy] = useState(false)

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

  const sections: { key: ObjectKey; rows: Associated[] }[] = [
    { key: 'contact', rows: contacts },
    { key: 'company', rows: companies },
    { key: 'deal', rows: deals },
  ]

  return (
    <div className="flex flex-col gap-3">
      {sections.map((section) => {
        if (section.key === object && section.rows.length === 0) return null
        const canLink = linkable.includes(section.key)

        return (
          <section key={section.key} className="rounded-panel border border-line bg-surface">
            <header className="flex items-center justify-between gap-2 border-b border-divider px-3 py-2">
              <h3 className="font-medium">
                {TITLES[section.key]} ({section.rows.length})
              </h3>
              {canWrite && canLink ? (
                <span className="flex items-center gap-1">
                  {createFields[section.key] ? (
                    <Button variant="tertiary" onClick={() => setCreating(section.key)}>
                      New
                    </Button>
                  ) : null}
                  <Button
                    variant="tertiary"
                    onClick={() => {
                      setChoice(null)
                      setAdding(adding === section.key ? null : section.key)
                    }}
                  >
                    Add
                  </Button>
                </span>
              ) : null}
            </header>

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

            {section.rows.length === 0 ? (
              <p className="px-3 py-3 text-secondary">
                Nothing linked yet.{' '}
                {canWrite && canLink
                  ? 'Use Add to connect one.'
                  : 'A link appears here when one is made.'}
              </p>
            ) : (
              <ul className="flex flex-col">
                {section.rows.map((row) => (
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
          </section>
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
