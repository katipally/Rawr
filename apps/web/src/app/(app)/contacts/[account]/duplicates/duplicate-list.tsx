'use client'

import { Button, DataTable, EmptyState, useToast, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useState } from 'react'
import { rowPill } from '~/components/row-actions.tsx'
import { recordPath } from '~/lib/links.ts'
import { useOrigin } from '~/lib/use-origin.ts'
import { api, errorMessage, trpc } from '~/lib/rpc.ts'
import { useFormat } from '~/components/zone.tsx'
import { useQueryClient } from '@tanstack/react-query'
import { ReviewDialog, type MergeField } from './review-dialog.tsx'

type Side = { id: string; displayName: string; createdAt: string }

export type Pair = {
  rule: string
  because: string
  keep: Side
  absorb: Side
}

export type DuplicateListProps = {
  account: string
  object: 'contact' | 'company'
  pairs: Pair[]
  /** What the server asked for. The queue is capped, so the count on screen is
   *  "the first n", never "all of them". */
  limit: number
  /** What a merge can choose between, in the order the record page shows them. */
  fields: MergeField[]
}

/** The cap the data access layer enforces. Asking for more is refused, so Show
 *  more stops offering itself here rather than throwing there. */
const MAX = 200

/** The rule that proposed a pair, in the words the rule is named in. Shown
 *  because two pairs with the same sentence can come from different rules, and
 *  which rule fired is what tells you whether to trust it. */
const RULES: Record<string, string> = {
  same_address: 'Same email',
  same_person_at_company: 'Same email once dots and plus tags are ignored',
  same_name_and_company: 'Same name at the same company',
  same_phone: 'Same phone',
  same_domain: 'Same domain',
  same_name_ignoring_suffix: 'Same name, different legal form',
}

/** HubSpot's manage duplicates table: a row per pair with both records in it,
 *  why the pair was proposed, and Review and Reject on the row.
 *
 *  Two things this deliberately does not do. It does not merge in bulk: the
 *  action is irreversible and a button that runs it forty times is a button
 *  somebody presses once by accident. And Review is the only way to merge, so
 *  nobody merges a pair without having seen both records side by side. */
export const DuplicateList = ({ account, object, pairs, limit, fields }: DuplicateListProps) => {
  const queryClient = useQueryClient()
  const fmt = useFormat()
  const origin = useOrigin()
  const toast = useToast()
  const [rows, setRows] = useState(pairs)
  const [asked, setAsked] = useState(limit)
  const [loading, setLoading] = useState(false)
  /** Pairs settled here, merged or rejected, and records a merge removed. The
   *  queue is re-derived from the records on every visit, so these only keep the
   *  screen honest until then. */
  const [settled, setSettled] = useState<Set<string>>(new Set())
  const [gone, setGone] = useState<Set<string>>(new Set())
  const [reviewing, setReviewing] = useState<string | null>(null)

  const keyOf = (pair: Pair) => `${pair.keep.id}:${pair.absorb.id}`

  /** Hidden the moment it is clicked and written behind that. A dismissal that
   *  failed to save would come back on the next visit; putting the row back on
   *  screen is what says so while the person is still looking at it. */
  const reject = async (pair: Pair) => {
    const key = keyOf(pair)
    setSettled((all) => new Set(all).add(key))
    try {
      await api.crm.records.dismissDuplicate.mutate({
        object,
        leftId: pair.keep.id,
        rightId: pair.absorb.id,
      })
    } catch (cause) {
      setSettled((all) => {
        const next = new Set(all)
        next.delete(key)
        return next
      })
      toast('error', errorMessage(cause))
    }
  }

  // The finder has no cursor: it ranks the whole account and takes the top n,
  // so a bigger page is a bigger n rather than a next page. n is capped at 200,
  // which is why this asks once more and then stops.
  const showMore = async () => {
    const next = Math.min(asked + limit, MAX)
    setLoading(true)
    try {
      const more = await queryClient.fetchQuery({ ...trpc.crm.records.duplicates.queryOptions({ object, limit: next }), staleTime: 0 })
      setRows(
        more.map((pair) => ({
          ...pair,
          keep: { ...pair.keep, createdAt: new Date(pair.keep.createdAt).toISOString() },
          absorb: { ...pair.absorb, createdAt: new Date(pair.absorb.createdAt).toISOString() },
        })),
      )
      setAsked(next)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }

  const capped = rows.length >= asked
  const visible = rows.filter(
    (pair) => !settled.has(keyOf(pair)) && !gone.has(pair.keep.id) && !gone.has(pair.absorb.id),
  )
  const open = visible.find((pair) => keyOf(pair) === reviewing) ?? null
  const after = (pair: Pair) => {
    const at = visible.findIndex((candidate) => keyOf(candidate) === keyOf(pair))
    return visible.find((candidate, index) => index > at && keyOf(candidate) !== keyOf(pair)) ?? null
  }

  const columns: Column<Pair>[] = [
    {
      key: 'records',
      header: object === 'company' ? 'Company' : 'Contact',
      width: 320,
      render: (pair) => (
        <span className="flex min-w-0 flex-col gap-1 py-2">
          {[pair.keep, pair.absorb].map((side) => (
            <Link
              key={side.id}
              href={recordPath(account, object, side.id, { from: origin })}
              title={side.displayName}
              className="block truncate font-semibold"
            >
              {side.displayName}
            </Link>
          ))}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Create date',
      width: 180,
      render: (pair) => (
        <span className="flex flex-col gap-1 py-2 whitespace-nowrap">
          <span>{fmt.date(pair.keep.createdAt)}</span>
          <span>{fmt.date(pair.absorb.createdAt)}</span>
        </span>
      ),
    },
    {
      key: 'reason',
      header: 'Why',
      width: 420,
      render: (pair) => (
        <span className="flex min-w-0 flex-col items-start gap-1 py-2">
          {RULES[pair.rule] ? (
            <span className="rounded-pill bg-fill px-2 text-small font-semibold">{RULES[pair.rule]}</span>
          ) : null}
          <span className="line-clamp-2 break-words text-secondary">{pair.because}</span>
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      width: 120,
      render: (pair) => (
        <span className="flex flex-col items-start gap-1.5 py-2">
          <button type="button" className={rowPill} onClick={() => setReviewing(keyOf(pair))}>
            Review
          </button>
          <button type="button" className={rowPill} onClick={() => void reject(pair)}>
            Reject
          </button>
        </span>
      ),
    },
  ]

  if (visible.length === 0) {
    return (
      <EmptyState
        title={rows.length === 0 ? 'Nothing looks duplicated' : 'Nothing left in the queue'}
        {...(rows.length === 0
          ? {}
          : { description: 'Everything proposed has been merged or set aside. Reload to look again.' })}
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-secondary tabular-nums">
        {fmt.number(visible.length)} pair{visible.length === 1 ? '' : 's'} to look at
        {capped ? `, the first ${fmt.number(asked)} the rules found` : ''}
      </p>

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={keyOf}
        caption={`Possible duplicate ${object === 'company' ? 'companies' : 'contacts'}`}
        storageKey="duplicates.pairs"
      />

      {capped && asked < MAX ? (
        <Button variant="tertiary" busy={loading} className="self-start" onClick={() => void showMore()}>
          Look further back
        </Button>
      ) : null}

      {open ? (
        <ReviewDialog
          account={account}
          object={object}
          pair={open}
          fields={fields}
          onClose={() => setReviewing(null)}
          onNext={after(open) ? () => setReviewing(keyOf(after(open) as Pair)) : null}
          onDone={(pair, absorbedId) => {
            const next = after(pair)
            setSettled((all) => new Set(all).add(keyOf(pair)))
            // Every other pair that names the record a merge removed is stale now.
            if (absorbedId) setGone((all) => new Set(all).add(absorbedId))
            setReviewing(next ? keyOf(next) : null)
          }}
        />
      ) : null}
    </div>
  )
}
