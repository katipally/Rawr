'use client'

import type { FieldType } from '@rawr/db/registry'
import { Alert, Button, Modal, Spinner, cn, useToast } from '@rawr/ui'
import { useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Value } from '~/components/crm/value.tsx'
import { useFormat } from '~/components/zone.tsx'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage, trpc } from '~/lib/rpc.ts'
import type { Pair } from './duplicate-list.tsx'

export type MergeField = { key: string; label: string; type: FieldType }

type Loaded = { values: Record<string, unknown>; labels: Record<string, string> }
type Side = 'keep' | 'absorb'

const isBlank = (value: unknown): boolean =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)

const pill = 'min-h-[2.4375rem] px-6 text-[length:var(--rawr-text-body)] font-semibold'

/** HubSpot's "Merge duplicate records": the two records side by side to pick the
 *  one that stays, a pair of choices for every property they disagree on, and
 *  the record the merge will leave on the right. Each property starts on the
 *  primary's value unless the primary holds nothing there, because losing the
 *  only phone number on file to a blank is a deletion nobody asked for.
 *
 *  Merge and Reject move straight on to the next pair, as HubSpot's queue does. */
export const ReviewDialog = ({
  account,
  object,
  pair,
  fields,
  onDone,
  onNext,
  onClose,
}: {
  account: string
  object: 'contact' | 'company'
  pair: Pair
  fields: MergeField[]
  /** The pair is settled: merged (with the id that went) or rejected. */
  onDone: (pair: Pair, absorbedId: string | null) => void
  onNext: (() => void) | null
  onClose: () => void
}) => {
  const queryClient = useQueryClient()
  const fmt = useFormat()
  const toast = useToast()
  const [records, setRecords] = useState<Record<Side, Loaded> | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [primary, setPrimary] = useState<Side>('keep')
  const [picks, setPicks] = useState<Record<string, Side>>({})
  const [busy, setBusy] = useState<'merge' | 'reject' | null>(null)

  useEffect(() => {
    let dropped = false
    setRecords(null)
    setFailed(null)
    setPrimary('keep')
    setPicks({})
    const read = (id: string) =>
      queryClient.fetchQuery({ ...trpc.crm.records.get.queryOptions({ object, id }), staleTime: 0 })
    Promise.all([read(pair.keep.id), read(pair.absorb.id)])
      .then(([keep, absorb]) => {
        if (dropped) return
        if (!keep || !absorb) {
          setFailed('One of these two is no longer here: it was merged or deleted since the queue was read.')
          return
        }
        setRecords({
          keep: { values: keep.values, labels: keep.labels },
          absorb: { values: absorb.values, labels: absorb.labels },
        })
      })
      .catch((cause: unknown) => {
        if (!dropped) setFailed(errorMessage(cause))
      })
    return () => {
      dropped = true
    }
  }, [pair, object, queryClient])

  const other: Side = primary === 'keep' ? 'absorb' : 'keep'
  const differing = records
    ? fields.filter((field) => String(records.keep.values[field.key] ?? '') !== String(records.absorb.values[field.key] ?? ''))
    : []
  const sideFor = (key: string): Side =>
    picks[key] ?? (records && isBlank(records[primary].values[key]) && !isBlank(records[other].values[key]) ? other : primary)

  const merge = async () => {
    setBusy('merge')
    const survivor = pair[primary]
    const absorbed = pair[other]
    try {
      await api.crm.records.merge.mutate({
        object,
        survivorId: survivor.id,
        absorbedId: absorbed.id,
        // Every differing field is sent, defaults included, so a default nobody
        // looked at is still recorded as the choice it was.
        picks: Object.fromEntries(
          differing.map((field) => [field.key, sideFor(field.key) === primary ? 'survivor' : 'absorbed']),
        ),
      })
      toast('success', `${absorbed.displayName} was merged into ${survivor.displayName}.`)
      onDone(pair, absorbed.id)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const reject = async () => {
    setBusy('reject')
    try {
      await api.crm.records.dismissDuplicate.mutate({ object, leftId: pair.keep.id, rightId: pair.absorb.id })
      onDone(pair, null)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const shown = (side: Side, field: MergeField) =>
    records ? (
      <Value
        format={fmt}
        type={field.type}
        value={records[side].values[field.key]}
        label={records[side].labels[field.key]}
        placeholder="--"
        oneLine
      />
    ) : null

  const tile = (on: boolean) =>
    cn(
      'flex min-w-0 cursor-pointer items-start gap-2 rounded-hs border transition-colors duration-150 ease-out',
      on ? 'border-tooltip bg-canvas' : 'border-line-strong bg-surface hover:bg-fill',
    )

  return (
    <Modal
      open
      size="lg"
      title="Merge duplicate records"
      onClose={onClose}
      footer={
        <div className="flex w-full flex-wrap gap-3">
          <Button variant="primary" className={pill} busy={busy === 'merge'} disabled={!records || busy !== null} onClick={() => void merge()}>
            {onNext ? 'Merge and review next' : 'Merge'}
          </Button>
          <Button className={pill} busy={busy === 'reject'} disabled={busy !== null} onClick={() => void reject()}>
            {onNext ? 'Reject and review next' : 'Reject'}
          </Button>
          {onNext ? (
            <Button className={pill} disabled={busy !== null} onClick={onNext}>
              Review next
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="@container flex min-w-0 flex-col gap-4">
        <h3 className="text-xl font-medium">Customize your record merge</h3>
        {failed ? (
          <Alert>{failed}</Alert>
        ) : !records ? (
          <div className="flex justify-center py-12">
            <Spinner size="lg" label="Reading both records" />
          </div>
        ) : (
          <div className="grid min-w-0 gap-6 bg-fill-header-hover px-4 py-4 sm:px-8 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
            <div className="flex min-w-0 flex-col gap-4">
              <fieldset className="flex min-w-0 flex-col gap-2">
                <legend className="mb-2 font-semibold">Select primary record</legend>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['keep', 'absorb'] as const).map((side) => (
                    <label key={side} className={cn(tile(primary === side), 'p-3')}>
                      <input
                        type="radio"
                        name="primary"
                        checked={primary === side}
                        onChange={() => {
                          setPrimary(side)
                          setPicks({})
                        }}
                        className="mt-1 shrink-0"
                      />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="break-words font-semibold">{pair[side].displayName}</span>
                        <Link
                          href={recordPath(account, object, pair[side].id)}
                          target="_blank"
                          className="w-fit text-small font-semibold"
                        >
                          View record
                        </Link>
                        <span className="text-small text-secondary">Create date</span>
                        <span>{fmt.dateTime(pair[side].createdAt)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="flex min-w-0 flex-col gap-2">
                <legend className="mb-2 font-semibold">Customize properties</legend>
                {differing.length === 0 ? (
                  <p className="text-secondary">
                    The two hold the same values, so there is nothing to choose between. Merging still moves the
                    timeline and the links.
                  </p>
                ) : (
                  differing.map((field) => (
                    <div key={field.key} role="radiogroup" aria-label={field.label} className="grid gap-3 sm:grid-cols-2">
                      {(['keep', 'absorb'] as const).map((side) => (
                        <label key={side} className={cn(tile(sideFor(field.key) === side), 'px-3 py-2')}>
                          <input
                            type="radio"
                            name={`pick-${field.key}`}
                            checked={sideFor(field.key) === side}
                            onChange={() => setPicks((current) => ({ ...current, [field.key]: side }))}
                            className="mt-1 shrink-0"
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="text-small text-secondary">{field.label}</span>
                            <span className="min-w-0 truncate">{shown(side, field)}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  ))
                )}
              </fieldset>
            </div>

            <section className="flex min-w-0 flex-col gap-3 self-start rounded-panel bg-surface p-4 shadow-panel">
              <h4 className="font-semibold">View merged record preview</h4>
              <p className="break-words text-lg font-semibold">{pair[primary].displayName}</p>
              <dl className="flex min-w-0 flex-col gap-2">
                <div>
                  <dt className="text-small text-secondary">Create date</dt>
                  <dd>{fmt.dateTime(pair[primary].createdAt)}</dd>
                </div>
                {differing.map((field) => (
                  <div key={field.key} className="min-w-0">
                    <dt className="text-small text-secondary">{field.label}</dt>
                    <dd className="truncate">{shown(sideFor(field.key), field)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </div>
        )}
        <Alert tone="warning">
          Merging cannot be undone. Everything the other record holds moves across: its timeline, its links, its
          subscriptions and its tasks. The other record is then deleted. Reject keeps the pair out of this queue for
          good.
        </Alert>
      </div>
    </Modal>
  )
}
