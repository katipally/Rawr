'use client'

import { Button, EmptyState, Field, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { formatDateTime } from '~/components/crm/value.tsx'
import { useZone } from '~/components/zone.tsx'
import { api, errorMessage } from '~/lib/rpc.ts'

type Deleted = { id: string; name: string; deletedAt: string; deletedBy: string | null }

export type RestoreListProps = {
  object: string
  objectLabel: string
  objectPlural: string
  /** What the server asked for first, and the step Show more takes. */
  limit: number
  initial: { rows: Deleted[]; total: number }
}

/** The cap the data access layer enforces. Past it a search is the way to narrow,
 *  so Show more stops offering itself here rather than throwing there. */
const MAX = 200

type Failure = { id: string; displayName: string; reason: string }

/** One row per deleted record, each with its own Restore, and one button that puts
 *  back everything on screen: a bulk delete of fifty is undone in one click, and a
 *  search narrows what "everything" means. */
export const RestoreList = ({ object, objectLabel, objectPlural, limit, initial }: RestoreListProps) => {
  const zone = useZone()
  const toast = useToast()
  const router = useRouter()
  const [rows, setRows] = useState(initial.rows)
  const [total, setTotal] = useState(initial.total)
  const [search, setSearch] = useState('')
  const [asked, setAsked] = useState(limit)
  const [busy, setBusy] = useState<string | 'all' | 'load' | null>(null)
  const [failed, setFailed] = useState<Failure[]>([])

  const load = async (wanted: number, text: string) => {
    setBusy('load')
    try {
      const found = await api.crm.records.deleted.query({ object, limit: wanted, ...(text ? { search: text } : {}) })
      setRows(found.rows.map((row) => ({ ...row, deletedAt: new Date(row.deletedAt).toISOString() })))
      setTotal(found.total)
      setAsked(wanted)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const restore = async (ids: string[], key: string) => {
    setBusy(key)
    try {
      const result = await api.crm.records.restore.mutate({ object, ids })
      setFailed(result.failed)
      const back = new Set(ids.filter((id) => !result.failed.some((row) => row.id === id)))
      setRows((current) => current.filter((row) => !back.has(row.id)))
      setTotal((current) => current - back.size)
      if (result.restored > 0) toast('success', `${result.restored.toLocaleString()} put back.`)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const capped = rows.length < total

  return (
    <section className="flex flex-col gap-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void load(limit, search.trim())
        }}
      >
        <div className="min-w-0 flex-1">
          <Field label="Search" id="restore-search">
            <TextInput
              id="restore-search"
              type="search"
              placeholder={`Name of a deleted ${objectLabel.toLowerCase()}`}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" busy={busy === 'load'}>
          Search
        </Button>
      </form>

      {failed.length > 0 ? (
        <div role="alert" className="flex flex-col gap-1">
          <p className="text-error">{failed.length} could not be restored. The rest were.</p>
          <ul className="flex flex-col gap-0.5">
            {failed.map((row) => (
              <li key={row.id} className="text-small text-secondary">
                <span className="font-medium">{row.displayName}</span> {row.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title={`No deleted ${objectPlural.toLowerCase()}`}
          description={
            search.trim()
              ? 'Nothing deleted matches that name.'
              : `A ${objectLabel.toLowerCase()} somebody deletes shows up here, and stays until it is put back.`
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-secondary tabular-nums">
              {total.toLocaleString()} deleted {(total === 1 ? objectLabel : objectPlural).toLowerCase()}
              {capped ? `, showing the newest ${rows.length.toLocaleString()}` : ''}
            </p>
            <Button
              variant="secondary"
              busy={busy === 'all'}
              disabled={busy !== null && busy !== 'all'}
              onClick={() => void restore(rows.map((row) => row.id), 'all')}
            >
              Restore {rows.length === 1 ? 'it' : `these ${rows.length.toLocaleString()}`}
            </Button>
          </div>
          <ul className="flex flex-col gap-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-panel border border-line bg-surface p-3"
              >
                <span className="min-w-0 flex-1 truncate font-medium" title={row.name}>
                  {row.name}
                </span>
                <span className="text-small text-secondary">
                  deleted {formatDateTime(row.deletedAt, zone)}
                  {row.deletedBy ? ` by ${row.deletedBy}` : ''}
                </span>
                <Button
                  variant="secondary"
                  busy={busy === row.id}
                  disabled={busy !== null && busy !== row.id}
                  onClick={() => void restore([row.id], row.id)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>

          {capped && asked < MAX ? (
            <Button
              variant="tertiary"
              busy={busy === 'load'}
              className="self-start"
              onClick={() => void load(Math.min(asked + limit, MAX), search.trim())}
            >
              Show more
            </Button>
          ) : null}
        </>
      )}
    </section>
  )
}
