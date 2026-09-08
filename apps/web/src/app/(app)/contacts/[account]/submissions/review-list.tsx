'use client'

import type { SubmissionRow } from '@rawr/db'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button, useToast } from '@rawr/ui'
import { recordPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

/** Each held submission shows what was submitted and exactly which rule caught
 *  it, because "score 45" tells a person nothing about whether this is a real
 *  prospect. Releasing runs the full capture path and creates the contact. */

export const ReviewList = ({
  account,
  rows,
  canReview,
  state,
}: {
  account: string
  rows: SubmissionRow[]
  canReview: boolean
  state: string
}) => {
  const router = useRouter()
  const toast = useToast()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState<string | null>(null)

  const act = async (id: string, action: 'release' | 'confirmSpam') => {
    setBusy(id)
    try {
      if (action === 'release') {
        const result = await api.forms.release.mutate({ id })
        toast(
          result.contactId ? 'success' : 'info',
          result.contactId
            ? 'Released. The contact has been created and the submission is on their timeline.'
            : 'Released, but no contact could be created: the submission has no usable email.',
        )
      } else {
        await api.forms.confirmSpam.mutate({ id })
        toast('success', 'Marked as spam. It is kept for 90 days and creates no contact.')
      }
      startTransition(() => router.refresh())
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  /** Minted per click and short lived, so nothing on this page is a URL that
   *  keeps working after somebody closes it. */
  const openFile = async (submissionId: string, uploadId: string) => {
    try {
      const { url } = await api.forms.uploadLink.mutate({ submissionId, uploadId })
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      toast('error', errorMessage(cause))
    }
  }

  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <li key={row.id} className="rounded-panel border border-line bg-surface p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="font-medium">{row.formName}</span>
            <span className="text-xs text-secondary">
              {new Date(row.at).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
              {' · score '}
              {row.spamScore}
            </span>
          </div>

          <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(6rem,auto)_1fr]">
            {/* A file answer is the upload's id, which says nothing to a person.
                The chip below carries the filename, so the id is dropped here
                rather than printed twice in two unhelpful forms. */}
            {Object.entries(row.values)
              .filter(([, value]) => !row.uploads.some((file) => file.id === value))
              .map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-xs text-secondary sm:pt-0.5">{key}</dt>
                  {/* Long answers wrap rather than stretching the row, and a
                      500-character message does not break the layout. */}
                  <dd className="min-w-0 break-words whitespace-pre-wrap">
                    {Array.isArray(value) ? value.join(', ') : String(value)}
                  </dd>
                </div>
              ))}
          </dl>

          {row.uploads.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {row.uploads.map((file) => (
                <li key={file.id} className="list-none">
                  <button
                    type="button"
                    onClick={() => void openFile(row.id, file.id)}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-pill border border-line-strong px-3 py-1 text-small hover:bg-fill"
                  >
                    <span className="truncate">{file.filename}</span>
                    <span className="shrink-0 text-secondary">{sizeOf(file.bytes)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {row.spamReasons.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-0.5 text-xs text-secondary">
              {row.spamReasons.map((reason, index) => (
                <li key={`${reason.rule}-${index}`}>
                  <span className="font-medium">
                    {reason.points > 0 ? `+${reason.points}` : '·'}
                  </span>{' '}
                  {reason.detail}
                </li>
              ))}
            </ul>
          ) : null}

          {row.attribution?.pagePath || row.attribution?.referrer ? (
            <p className="mt-2 truncate text-xs text-secondary">
              {row.attribution.pagePath ?? ''} {row.attribution.referrer ? `· from ${row.attribution.referrer}` : ''}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {row.contactId ? (
              <Link
                href={recordPath(account, 'contact', row.contactId)}
                className="text-sm font-semibold text-link"
              >
                Open contact
              </Link>
            ) : null}

            {canReview && state === 'quarantined' ? (
              <>
                <Button
                  type="button"
                  variant="primary"
                  disabled={busy === row.id || pending}
                  onClick={() => void act(row.id, 'release')}
                >
                  {busy === row.id ? 'Releasing…' : 'This is a real lead'}
                </Button>
                <Button
                  type="button"
                  disabled={busy === row.id || pending}
                  onClick={() => void act(row.id, 'confirmSpam')}
                >
                  This is spam
                </Button>
              </>
            ) : null}

            {!canReview && state === 'quarantined' ? (
              <span className="text-xs text-secondary">
                Your role can read this queue but not act on it.
              </span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Rounded to the unit a person reads, not the one the disk uses. */
const sizeOf = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
