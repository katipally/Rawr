'use client'

import { Alert, Button, EmptyState, Field, Modal, Select, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { formatDate, shortName } from '~/components/crm/value.tsx'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useZone } from '~/components/zone.tsx'

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

/** One row per pair, with the reason in front of the decision.
 *
 *  Two things this deliberately does not do. It does not merge in bulk: the
 *  action is irreversible and a button that runs it forty times is a button
 *  somebody presses once by accident. And it does not offer field-by-field
 *  picking here, because that dialog already exists on the record and having two
 *  of it is how the two drift apart. Merging from here keeps everything the older
 *  record holds, which is what the queue proposes; anything finer is one click
 *  away on the record itself. */
export const DuplicateList = ({ account, object, pairs, limit }: DuplicateListProps) => {
  const zone = useZone()
  const router = useRouter()
  const toast = useToast()
  const [rows, setRows] = useState(pairs)
  const [asked, setAsked] = useState(limit)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [swapped, setSwapped] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState<Pair | null>(null)

  const keyOf = (pair: Pair) => `${pair.keep.id}:${pair.absorb.id}`

  const sideOf = (pair: Pair) => {
    const flip = swapped.has(keyOf(pair))
    return { survivor: flip ? pair.absorb : pair.keep, absorbed: flip ? pair.keep : pair.absorb }
  }

  const merge = async (pair: Pair) => {
    const key = keyOf(pair)
    const { survivor, absorbed } = sideOf(pair)
    setBusy(key)
    try {
      await api.crm.records.merge.mutate({
        object,
        survivorId: survivor.id,
        absorbedId: absorbed.id,
        // Empty: the survivor keeps its own values, which is what "keep this one"
        // means. Field-by-field picking lives on the record.
        picks: {},
      })
      setConfirming(null)
      toast('success', `${absorbed.displayName} was merged into ${survivor.displayName}.`)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  /** Hidden here the moment it is clicked and written behind that. The queue is
   *  re-derived from the records on every visit, so a dismissal that failed to
   *  save would come back on the next one; putting the row back on screen is
   *  what says so while the person is still looking at it. */
  const dismiss = async (pair: Pair) => {
    const key = keyOf(pair)
    setDismissed((all) => new Set(all).add(key))
    try {
      await api.crm.records.dismissDuplicate.mutate({
        object,
        leftId: pair.keep.id,
        rightId: pair.absorb.id,
      })
    } catch (cause) {
      setDismissed((all) => {
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
      const more = await api.crm.records.duplicates.query({ object, limit: next })
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
  const visible = rows.filter((pair) => !dismissed.has(keyOf(pair)))

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
    <div className="flex flex-col gap-3">
      <p className="text-secondary tabular-nums">
        {visible.length} pair{visible.length === 1 ? '' : 's'} to look at
        {capped ? `, the first ${asked} the rules found` : ''}
      </p>

      <ul className="flex flex-col gap-2">
        {visible.map((pair) => {
          const key = keyOf(pair)
          const flip = swapped.has(key)
          const survivor = flip ? pair.absorb : pair.keep
          const absorbed = flip ? pair.keep : pair.absorb
          return (
            <li key={key} className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3">
              <p className="text-secondary">
                {RULES[pair.rule] ? (
                  <span className="mr-2 rounded-hs bg-fill px-1.5 py-0.5 text-small">
                    {RULES[pair.rule]}
                  </span>
                ) : null}
                {pair.because}
              </p>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link
                  href={recordPath(account, object, survivor.id)}
                  title={survivor.displayName}
                  className="min-w-0 truncate font-medium"
                >
                  {survivor.displayName}
                </Link>
                <span className="text-small text-secondary">kept, here since {formatDate(survivor.createdAt, zone)}</span>
                <span aria-hidden="true" className="text-secondary">
                  &larr;
                </span>
                <Link
                  href={recordPath(account, object, absorbed.id)}
                  title={absorbed.displayName}
                  className="min-w-0 truncate"
                >
                  {absorbed.displayName}
                </Link>
                <span className="text-small text-secondary">merged in, here since {formatDate(absorbed.createdAt, zone)}</span>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button variant="primary" busy={busy === key} onClick={() => setConfirming(pair)}>
                  Merge into {shortName(survivor.displayName)}
                </Button>
                <Button
                  onClick={() =>
                    setSwapped((all) => {
                      const next = new Set(all)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })
                  }
                >
                  Keep the other one instead
                </Button>
                <Button variant="tertiary" onClick={() => void dismiss(pair)}>
                  Not the same
                </Button>
              </div>
            </li>
          )
        })}
      </ul>

      {capped && asked < MAX ? (
        <Button variant="tertiary" busy={loading} className="self-start" onClick={() => void showMore()}>
          Look further back
        </Button>
      ) : null}

      <Alert tone="info">
        Merging cannot be undone. Everything the other record holds moves across: its timeline, its
        links, its subscriptions and its tasks. &ldquo;Not the same&rdquo; keeps the pair out of this
        queue for good and changes no rule, because a rule that learns from a dismissal is a rule
        nobody can predict.
      </Alert>

      <Modal
        open={confirming !== null}
        size="sm"
        title="Merge these two?"
        onClose={() => setConfirming(null)}
      >
        {confirming ? (
          <div className="flex flex-col gap-3">
            <Alert tone="warning">
              This cannot be undone. Everything the other record holds moves across: its timeline,
              its links, its subscriptions and its tasks. The other record is then deleted.
            </Alert>

            {/* The choice is repeated here rather than only on the row: the row's
                own swap is two clicks away from the merge, and this is the last
                screen before an irreversible write. */}
            <Field id="duplicate-survivor" label="Which one is kept">
              <Select
                id="duplicate-survivor"
                value={swapped.has(keyOf(confirming)) ? 'absorb' : 'keep'}
                onChange={(event) =>
                  setSwapped((all) => {
                    const next = new Set(all)
                    if (event.target.value === 'absorb') next.add(keyOf(confirming))
                    else next.delete(keyOf(confirming))
                    return next
                  })
                }
              >
                <option value="keep">{confirming.keep.displayName}</option>
                <option value="absorb">{confirming.absorb.displayName}</option>
              </Select>
            </Field>

            <p className="text-secondary break-words">
              {sideOf(confirming).absorbed.displayName} is merged into{' '}
              {sideOf(confirming).survivor.displayName}.
            </p>

            <div className="flex flex-wrap gap-2">
              <Button variant="tertiary" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                busy={busy === keyOf(confirming)}
                onClick={() => void merge(confirming)}
              >
                Merge into {shortName(sideOf(confirming).survivor.displayName)}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  )
}
