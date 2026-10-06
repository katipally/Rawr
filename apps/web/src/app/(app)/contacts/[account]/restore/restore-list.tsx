'use client'

import { Button, DataTable, EmptyState, Modal, useToast, type Column } from '@rawr/ui'
import { Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { useFormat } from '~/components/zone.tsx'
import { api, errorMessage, trpc } from '~/lib/rpc.ts'
import { useQueryClient } from '@tanstack/react-query'

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

const bulkAction =
  'inline-flex h-[calc(var(--spacing-row)-2px)] shrink-0 items-center gap-1.5 rounded-pill px-2.5 text-body font-semibold transition-all duration-150 ease-out hover:bg-fill disabled:cursor-not-allowed disabled:text-muted disabled:hover:bg-transparent'

/** Long enough that typing a name is one search rather than one per letter. */
const SEARCH_DELAY_MS = 300

type Failure = { id: string; displayName: string; reason: string }

/** HubSpot's restore table: a box per deleted record, Restore on the hovered
 *  row, and the ticked rows restored together from the bar over the header after
 *  a confirm that names how many. A search narrows the list as it is typed. */
export const RestoreList = ({ object, objectLabel, objectPlural, limit, initial }: RestoreListProps) => {
  const queryClient = useQueryClient()
  const fmt = useFormat()
  const toast = useToast()
  const router = useRouter()
  const [rows, setRows] = useState(initial.rows)
  const [total, setTotal] = useState(initial.total)
  const [search, setSearch] = useState('')
  const [asked, setAsked] = useState(limit)
  const [busy, setBusy] = useState<string | 'selected' | 'load' | null>(null)
  const [failed, setFailed] = useState<Failure[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const searched = useRef('')

  const load = async (wanted: number, text: string) => {
    setBusy('load')
    try {
      const found = await queryClient.fetchQuery({ ...trpc.crm.records.deleted.queryOptions({ object, limit: wanted, ...(text ? { search: text } : {}) }), staleTime: 0 })
      // A slower answer to an earlier search must not overwrite a newer one.
      if (searched.current !== text) return
      setRows(found.rows.map((row) => ({ ...row, deletedAt: new Date(row.deletedAt).toISOString() })))
      setTotal(found.total)
      setAsked(wanted)
      setSelected((current) => new Set([...current].filter((id) => found.rows.some((row) => row.id === id))))
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new search is the only trigger
  useEffect(() => {
    const text = search.trim()
    if (text === searched.current) return
    const timer = window.setTimeout(() => {
      searched.current = text
      void load(limit, text)
    }, SEARCH_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [search])

  const restore = async (ids: string[], key: string) => {
    setBusy(key)
    try {
      const result = await api.crm.records.restore.mutate({ object, ids })
      setFailed(result.failed)
      const back = new Set(ids.filter((id) => !result.failed.some((row) => row.id === id)))
      setRows((current) => current.filter((row) => !back.has(row.id)))
      setTotal((current) => current - back.size)
      setSelected((current) => new Set([...current].filter((id) => !back.has(id))))
      if (result.restored > 0) toast('success', `${fmt.number(result.restored)} put back.`)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
      setConfirming(false)
    }
  }

  const capped = rows.length < total
  const noun = (count: number) => (count === 1 ? objectLabel : objectPlural).toLowerCase()

  const columns: Column<Deleted>[] = [
    {
      key: 'name',
      header: 'Name',
      width: 360,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-semibold" title={row.name}>
            {row.name}
          </span>
          <RowActions>
            <button
              type="button"
              className={rowPill}
              disabled={busy !== null}
              onClick={() => void restore([row.id], row.id)}
            >
              {busy === row.id ? 'Restoring…' : 'Restore'}
            </button>
          </RowActions>
        </span>
      ),
    },
    {
      key: 'deleted',
      header: 'Deleted',
      width: 220,
      render: (row) => <span className="whitespace-nowrap">{fmt.dateTime(row.deletedAt)}</span>,
    },
    {
      key: 'by',
      header: 'Deleted by',
      width: 220,
      render: (row) => <span className="block truncate">{row.deletedBy ?? EMPTY_VALUE}</span>,
    },
  ]

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative w-full min-w-0 @lg:w-60">
          <span className="sr-only">Search deleted {objectPlural.toLowerCase()}</span>
          <input
            type="search"
            value={search}
            placeholder={`Search deleted ${objectPlural.toLowerCase()}`}
            onChange={(event) => setSearch(event.target.value)}
            className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-9 pl-4 text-body placeholder:text-muted"
          />
          <Search aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
        </label>
        <p className="text-secondary tabular-nums" aria-live="polite">
          {busy === 'load' ? 'Searching…' : `${fmt.number(total)} deleted ${noun(total)}`}
          {capped && busy !== 'load' ? `, showing the newest ${fmt.number(rows.length)}` : ''}
        </p>
      </div>

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
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={`Deleted ${objectPlural.toLowerCase()}`}
            storageKey="restore.records"
            selection={{ selected, onChange: setSelected, noun: objectLabel.toLowerCase() }}
            headerBar={
              selected.size > 0 ? (
                <div
                  role="toolbar"
                  aria-label={`Actions for ${fmt.number(selected.size)} selected ${noun(selected.size)}`}
                  className="flex h-full min-w-0 animate-drop-in items-center gap-0.5 rounded-hs border border-line bg-surface pl-4 motion-reduce:animate-none"
                >
                  <span className="mr-3 min-w-0 shrink truncate font-semibold">
                    {fmt.number(selected.size)} {noun(selected.size)} selected
                  </span>
                  <button type="button" className={bulkAction} disabled={busy !== null} onClick={() => setConfirming(true)}>
                    Restore
                  </button>
                </div>
              ) : undefined
            }
          />

          {capped && asked < MAX ? (
            <Button
              variant="tertiary"
              busy={busy === 'load'}
              className="self-start"
              onClick={() => void load(Math.min(asked + limit, MAX), searched.current)}
            >
              Show more
            </Button>
          ) : null}
        </>
      )}

      <Modal
        open={confirming}
        size="sm"
        title={`Restore ${fmt.number(selected.size)} ${noun(selected.size)}?`}
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy === 'selected'} onClick={() => void restore([...selected], 'selected')}>
              Restore
            </Button>
          </>
        }
      >
        <p>
          {selected.size === 1 ? 'It comes' : 'They come'} back exactly as {selected.size === 1 ? 'it was' : 'they were'} when
          deleted: timeline, associations and properties.
        </p>
      </Modal>
    </section>
  )
}
