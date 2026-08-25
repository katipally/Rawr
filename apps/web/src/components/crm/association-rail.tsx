'use client'

import { Button, Select, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { ObjectKey } from '@rawr/db'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

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
  /** What can be linked from here, already narrowed to the sensible pairs. */
  candidates: { objectKey: ObjectKey; options: { id: string; label: string }[] }[]
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
  candidates,
  canWrite,
}: AssociationRailProps) => {
  const router = useRouter()
  const toast = useToast()
  const [adding, setAdding] = useState<ObjectKey | null>(null)
  const [choice, setChoice] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    try {
      await fn()
      toast('success', done)
      setAdding(null)
      setChoice('')
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
        const candidate = candidates.find((entry) => entry.objectKey === section.key)

        return (
          <section key={section.key} className="rounded-panel border border-line bg-surface">
            <header className="flex items-center justify-between gap-2 border-b border-divider px-3 py-2">
              <h3 className="font-medium">
                {TITLES[section.key]} ({section.rows.length})
              </h3>
              {canWrite && candidate && candidate.options.length > 0 ? (
                <Button variant="tertiary" onClick={() => setAdding(adding === section.key ? null : section.key)}>
                  Add
                </Button>
              ) : null}
            </header>

            {adding === section.key && candidate ? (
              <div className="flex flex-wrap items-center gap-2 border-b border-divider px-3 py-2">
                <Select
                  aria-label={`Pick a ${section.key} to link`}
                  value={choice}
                  onChange={(event) => setChoice(event.target.value)}
                  className="min-w-40 flex-1"
                >
                  <option value="">Pick one</option>
                  {candidate.options
                    .filter((option) => !section.rows.some((row) => row.id === option.id))
                    .map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                </Select>
                <Button
                  variant="primary"
                  busy={busy}
                  disabled={choice === ''}
                  onClick={() =>
                    void run(
                      () =>
                        api.crm.associations.add.mutate({
                          a: { entityType: object, entityId: recordId },
                          b: { entityType: section.key, entityId: choice },
                          label: null,
                        }),
                      'Linked.',
                    )
                  }
                >
                  Link
                </Button>
              </div>
            ) : null}

            {section.rows.length === 0 ? (
              <p className="px-3 py-3 text-secondary">
                Nothing linked yet.{' '}
                {canWrite && candidate && candidate.options.length > 0
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
    </div>
  )
}
