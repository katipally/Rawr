'use client'

import { Alert, Button } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { api } from '~/lib/rpc.ts'
import { useUploads } from '~/lib/store/uploads.ts'

/** The run before there is anything to map: its file is still going up, or it is
 *  up and the server is reading it.
 *
 *  Both are the server's version of events. When this tab is the one uploading,
 *  the store has a fresher number and it is used instead; when it is not -- the
 *  upload is in another tab, or this page was reloaded -- the run's own count is
 *  what shows. Either way the page moves on by itself when the mapper is ready. */

const POLL_MS = 1_500

const percent = (sent: number, total: number): number =>
  total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

export const ImportArriving = ({
  runId,
  filename,
  state,
  uploadedBytes,
  fileBytes,
  backHref,
}: {
  runId: string
  filename: string
  state: 'uploading' | 'parsing'
  uploadedBytes: number
  fileBytes: number
  backHref: string
}) => {
  const router = useRouter()
  const upload = useUploads((store) => store.uploads.find((row) => row.runId === runId))
  const stop = useUploads((store) => store.stop)
  const [live, setLive] = useState({ state, uploadedBytes })
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let dropped = false
    const ask = async () => {
      try {
        const run = await api.crm.imports.read.query({ id: runId })
        if (dropped || !run) return
        if (run.state !== 'uploading' && run.state !== 'parsing') {
          // The mapper, the preview or a failure: all of them are the server
          // component's to render, so this asks for it rather than drawing them.
          router.refresh()
          return
        }
        setLive({ state: run.state, uploadedBytes: run.uploadedBytes })
      } catch {
        // A poll that misses is a poll. The next one answers.
      }
    }
    void ask()
    const timer = setInterval(() => void ask(), POLL_MS)
    return () => {
      dropped = true
      clearInterval(timer)
    }
  }, [runId, router])

  const reading = live.state === 'parsing'
  // This tab's own count is ahead of the run's, because a part is recorded after
  // it lands; the run's is what a second tab or a reload has.
  const sent = Math.max(upload?.sent ?? 0, live.uploadedBytes)
  const done = percent(sent, fileBytes)

  const cancel = async () => {
    stop(runId)
    try {
      await api.crm.imports.discardUpload.mutate({ id: runId })
      router.push(backHref)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-6 shadow-panel">
      <h2 className="text-base font-semibold">
        {reading ? `Reading ${filename}` : `Uploading ${filename}`}
      </h2>

      <div
        role="progressbar"
        aria-label={reading ? 'Reading' : 'Upload'}
        aria-valuenow={reading ? undefined : done}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 w-full overflow-hidden rounded-hs bg-fill"
      >
        <div
          className={reading ? 'h-full w-full animate-pulse bg-accent' : 'h-full bg-accent transition-all'}
          style={reading ? undefined : { width: `${done}%` }}
        />
      </div>

      <p className="text-secondary tabular-nums" aria-live="polite">
        {reading
          ? 'The whole file is here. The server is reading it into rows, which takes seconds. The mapper opens by itself.'
          : `${done}% sent (${megabytes(sent)} of ${megabytes(fileBytes)}). This carries on if you move to another page, and what has arrived is kept if you close the tab.`}
      </p>

      {upload?.state === 'failed' && upload.error ? <Alert>{upload.error}</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}

      {!reading ? (
        <div>
          <Button onClick={() => void cancel()}>Stop and throw it away</Button>
        </div>
      ) : null}
    </div>
  )
}
