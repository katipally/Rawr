'use client'

import { Alert, Button, EmptyState, useToast } from '@rawr/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { shortName } from '~/components/crm/value.tsx'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

type Side = { id: string; displayName: string; createdAt: string }

export type Pair = {
  rule: string
  because: string
  keep: Side
  absorb: Side
}

export type DuplicateListProps = {
  workspace: string
  object: 'contact' | 'company'
  pairs: Pair[]
}

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

/** One row per pair, with the reason in front of the decision.
 *
 *  Two things this deliberately does not do. It does not merge in bulk: the
 *  action is irreversible and a button that runs it forty times is a button
 *  somebody presses once by accident. And it does not offer field-by-field
 *  picking here, because that dialog already exists on the record and having two
 *  of it is how the two drift apart. Merging from here keeps everything the older
 *  record holds, which is what the queue proposes; anything finer is one click
 *  away on the record itself. */
export const DuplicateList = ({ workspace, object, pairs }: DuplicateListProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [swapped, setSwapped] = useState<Set<string>>(new Set())

  const keyOf = (pair: Pair) => `${pair.keep.id}:${pair.absorb.id}`

  const merge = async (pair: Pair) => {
    const key = keyOf(pair)
    const flip = swapped.has(key)
    const survivor = flip ? pair.absorb : pair.keep
    const absorbed = flip ? pair.keep : pair.absorb
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
      toast('success', `${absorbed.displayName} was merged into ${survivor.displayName}.`)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const visible = pairs.filter((pair) => !dismissed.has(keyOf(pair)))

  if (visible.length === 0) {
    return (
      <EmptyState
        title={pairs.length === 0 ? 'Nothing looks duplicated' : 'Nothing left in the queue'}
        {...(pairs.length === 0
          ? {}
          : { description: 'Everything proposed has been merged or set aside. Reload to look again.' })}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-secondary tabular-nums">
        {visible.length} pair{visible.length === 1 ? '' : 's'} to look at
      </p>

      <ul className="flex flex-col gap-2">
        {visible.map((pair) => {
          const key = keyOf(pair)
          const flip = swapped.has(key)
          const survivor = flip ? pair.absorb : pair.keep
          const absorbed = flip ? pair.keep : pair.absorb
          return (
            <li key={key} className="flex flex-col gap-2 rounded-panel border border-line bg-surface p-3">
              <p className="text-secondary">{pair.because}</p>

              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link
                  href={recordPath(workspace, object, survivor.id)}
                  title={survivor.displayName}
                  className="min-w-0 truncate font-medium"
                >
                  {survivor.displayName}
                </Link>
                <span className="text-small text-secondary">kept, here since {when(survivor.createdAt)}</span>
                <span aria-hidden="true" className="text-secondary">
                  &larr;
                </span>
                <Link
                  href={recordPath(workspace, object, absorbed.id)}
                  title={absorbed.displayName}
                  className="min-w-0 truncate"
                >
                  {absorbed.displayName}
                </Link>
                <span className="text-small text-secondary">merged in, here since {when(absorbed.createdAt)}</span>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  busy={busy === key}
                  onClick={() => void merge(pair)}
                >
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
                <Button
                  variant="tertiary"
                  onClick={() => setDismissed((all) => new Set(all).add(key))}
                >
                  Not the same
                </Button>
              </div>
            </li>
          )
        })}
      </ul>

      <Alert tone="info">
        Merging cannot be undone. Everything the other record holds moves across: its timeline, its
        links, its subscriptions and its tasks. &ldquo;Not the same&rdquo; only hides the pair until
        you reload, because a rule that learns from a dismissal is a rule nobody can predict.
      </Alert>
    </div>
  )
}
