'use client'

import { cn, IconButton } from '@rawr/ui'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import type { ImportSummary } from '@rawr/db'
import { useEffect, useState } from 'react'
import { importsPath } from '~/lib/links.ts'
import { trpc } from '~/lib/rpc.ts'
import { useUploads, type Upload } from '~/lib/store/uploads.ts'
import { useFormat } from '~/components/zone.tsx'

/** Work that outlives the screen it was started on.
 *
 *  Long work in this app is the server's: a file is uploaded, read and imported by
 *  processes that do not care which page is open. What was missing was anywhere to
 *  see that from. Start an import and walk off to the contacts list and there was
 *  nothing to say it was still going, so people sat on the run page because
 *  leaving it felt unsafe.
 *
 *  So: a docked strip, mounted once in the shell, fed by the store for what this
 *  tab is uploading and by the server for what it is running. It is the only thing
 *  on screen that knows about both, and it is deliberately quiet -- it appears
 *  when there is something in flight and goes when there is not. */

/** Long enough that a finished import stays visible for somebody who was looking
 *  elsewhere, short enough that the strip does not become a log. */
const KEEP_DONE_MS = 30_000

/** Two rates, because the strip is empty on almost every page view. Watching
 *  something move wants three seconds; discovering that a colleague started an
 *  import in another tab does not, and a tab left open overnight should not spend
 *  the night asking. */
const POLL_ACTIVE_MS = 3_000
const POLL_IDLE_MS = 30_000

type Running = {
  id: string
  filename: string
  state: string
  processedRows: number
  totalRows: number
}

const ACTIVE: ImportSummary['state'][] = ['parsing', 'running']

const NONE: Running[] = []

const percent = (done: number, total: number): number =>
  total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0

export const TaskTray = ({ account }: { account: string }) => {
  const fmt = useFormat()
  const uploads = useUploads((store) => store.uploads)
  const dismiss = useUploads((store) => store.dismiss)
  const [open, setOpen] = useState(true)

  // The cache pauses the timer while the tab is hidden and asks again the moment it
  // is back, and hands over the same array while the numbers are the same, which
  // is what keeps the shell from re-rendering on a timer for ever.
  const { data: runs = NONE } = useQuery({
    ...trpc.crm.imports.list.queryOptions({ states: ACTIVE }),
    staleTime: 0,
    select: ({ rows }): Running[] =>
      rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        state: row.state,
        processedRows: row.processedRows,
        totalRows: row.totalRows,
      })),
    refetchInterval: (query) => ((query.state.data?.total ?? 0) > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS),
  })

  // A run in the tray is also an upload in the store once its parts have landed.
  // Showing both would be the same file twice, so the run wins: it is the one
  // with somewhere to go.
  const inFlight = uploads.filter((row) => !runs.some((run) => run.id === row.runId))
  const rows = inFlight.length + runs.length
  if (rows === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-flyout flex justify-end p-3 sm:p-4">
      <section
        aria-label="Work in progress"
        className="pointer-events-auto flex w-full max-w-sm flex-col overflow-hidden rounded-panel border border-line bg-surface shadow-panel"
      >
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <h2 className="min-w-0 flex-1 truncate text-small font-semibold">
            {rows === 1 ? '1 thing in progress' : `${rows} things in progress`}
          </h2>
          <IconButton
            label={open ? 'Hide' : 'Show'}
            onClick={() => setOpen(!open)}
            icon={open ? <ChevronDown aria-hidden="true" className="size-4" /> : <ChevronUp aria-hidden="true" className="size-4" />}
          />
        </header>

        {open ? (
          <ul className="flex max-h-72 flex-col overflow-y-auto">
            {inFlight.map((upload) => (
              <UploadRow key={upload.runId} upload={upload} account={account} onDismiss={() => dismiss(upload.runId)} />
            ))}
            {runs.map((run) => (
              <li key={run.id} className="flex flex-col gap-1 border-b border-line px-3 py-2 last:border-b-0">
                <Link href={importsPath(account, run.id)} className="truncate text-small no-underline">
                  {run.filename}
                </Link>
                <Bar value={run.state === 'parsing' ? null : percent(run.processedRows, run.totalRows)} />
                <p className="text-small text-secondary tabular-nums">
                  {run.state === 'parsing'
                    ? 'Reading the file'
                    : `${fmt.number(run.processedRows)} of ${fmt.number(run.totalRows)} rows`}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  )
}

const UploadRow = ({
  upload,
  account,
  onDismiss,
}: {
  upload: Upload
  account: string
  onDismiss: () => void
}) => {
  // A finished upload lingers so somebody who was on another page sees it landed,
  // then takes itself away.
  useEffect(() => {
    if (upload.state !== 'done' && upload.state !== 'stopped') return
    const timer = setTimeout(onDismiss, KEEP_DONE_MS)
    return () => clearTimeout(timer)
  }, [upload.state, onDismiss])

  const said: Record<Upload['state'], string> = {
    sending: `${percent(upload.sent, upload.bytes)}% uploaded`,
    sealing: 'Handing it over',
    done: 'Uploaded',
    stopped: 'Stopped',
    failed: upload.error ?? 'That upload failed',
  }

  return (
    <li className="flex flex-col gap-1 border-b border-line px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2">
        <Link href={importsPath(account, upload.runId)} className="min-w-0 flex-1 truncate text-small no-underline">
          {upload.filename}
        </Link>
        {upload.state === 'sending' ? null : <IconButton label="Dismiss" onClick={onDismiss} icon={<X aria-hidden="true" className="size-4" />} />}
      </div>
      <Bar value={upload.state === 'sealing' ? null : percent(upload.sent, upload.bytes)} failed={upload.state === 'failed'} />
      <p className={cn('text-small tabular-nums', upload.state === 'failed' ? 'text-danger' : 'text-secondary')}>
        {said[upload.state]}
      </p>
    </li>
  )
}

/** A null value is work whose end is not countable yet, which pulses rather than
 *  sitting at a number that never moves. */
const Bar = ({ value, failed }: { value: number | null; failed?: boolean }) => (
  <div
    role="progressbar"
    aria-valuenow={value ?? undefined}
    aria-valuemin={0}
    aria-valuemax={100}
    className="h-1 w-full overflow-hidden rounded-hs bg-fill"
  >
    <div
      className={cn('h-full', failed ? 'bg-danger' : 'bg-accent', value === null && 'w-full animate-pulse')}
      style={value === null ? undefined : { width: `${value}%` }}
    />
  </div>
)
