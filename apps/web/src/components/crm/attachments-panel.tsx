'use client'

import { Alert, Button, EmptyState, IconButton, useToast } from '@rawr/ui'
import { Paperclip } from 'lucide-react'
import { useRef, useState } from 'react'
import { ACTION_ICONS } from '~/components/icons.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

export type AttachmentView = {
  id: string
  filename: string
  bytes: number
  mime: string
  at: string
}

/** Files on a record.
 *
 *  The bytes go straight from this browser to storage and never through Rawr: a
 *  signed URL is asked for, the file is PUT to it, and only then is the row
 *  written. So a failed upload leaves nothing on the record, and a large file
 *  never occupies a request worker.
 *
 *  Reading is the same in reverse — a link is minted per click and expires — so
 *  the bucket is never public and a URL copied out of the page stops working. */
export const AttachmentsPanel = ({
  object,
  recordId,
  rows,
  configured,
  canWrite,
}: {
  /** An object key, core or invented. */
  object: string
  recordId: string
  rows: AttachmentView[]
  configured: boolean
  canWrite: boolean
}) => {
  const toast = useToast()
  const picker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [files, setFiles] = useState(rows)

  const size = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`

  const upload = async (file: File) => {
    setBusy('upload')
    try {
      const signed = await api.crm.attachments.sign.mutate({
        entityType: object,
        entityId: recordId,
        filename: file.name,
        bytes: file.size,
        mime: file.type || 'application/octet-stream',
      })

      const put = await fetch(signed.url, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      })
      if (!put.ok) throw new Error(`The upload was refused (${put.status}). Try again.`)

      // Only now: a row that exists is a file that landed.
      const made = await api.crm.attachments.confirm.mutate({
        entityType: object,
        entityId: recordId,
        storageKey: signed.storageKey,
        filename: file.name,
        bytes: file.size,
        mime: file.type || 'application/octet-stream',
      })
      setFiles((current) => [
        { id: made.id, filename: file.name, bytes: file.size, mime: file.type, at: new Date().toISOString() },
        ...current,
      ])
      toast('success', `${file.name} was attached.`)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
      if (picker.current) picker.current.value = ''
    }
  }

  const open = async (row: AttachmentView) => {
    setBusy(row.id)
    try {
      const { url } = await api.crm.attachments.link.mutate({ id: row.id })
      // A new tab rather than a navigation: the link expires, and going back to a
      // dead one is worse than opening it beside the record.
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  const remove = async (row: AttachmentView) => {
    setBusy(row.id)
    try {
      await api.crm.attachments.remove.mutate({ id: row.id })
      setFiles((current) => current.filter((each) => each.id !== row.id))
      toast('success', `${row.filename} was deleted.`)
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-panel border border-line bg-surface">
      <h3 className="border-b border-divider px-3 py-2 font-medium">
        Files{files.length > 0 ? ` (${files.length})` : ''}
      </h3>
      <div className="flex min-w-0 flex-col gap-2 p-3">
      {!configured ? (
        <Alert tone="info">
          File storage is not connected, so nothing can be attached yet. An admin sets
          SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and creates the bucket.
        </Alert>
      ) : files.length === 0 ? (
        <EmptyState
          title="No files yet"
          description="A contract, a deck, a signed order form: anything that belongs to this record rather than to an email about it."
        />
      ) : (
        <ul className="flex flex-col">
          {files.map((row) => (
            <li
              key={row.id}
              className="flex min-w-0 items-center gap-2 border-b border-divider py-1.5 last:border-0"
            >
              <Paperclip aria-hidden="true" size={16} className="shrink-0 text-secondary" />
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void open(row)}
                title={row.filename}
                className="min-w-0 flex-1 truncate text-left text-link"
              >
                {row.filename}
              </button>
              <span className="shrink-0 text-small text-secondary tabular-nums">{size(row.bytes)}</span>
              {canWrite ? (
                <IconButton
                  label={`Delete ${row.filename}`}
                  tone="destructive"
                  icon={<ACTION_ICONS.delete size={16} />}
                  disabled={busy !== null}
                  onClick={() => void remove(row)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite && configured ? (
        <div>
          <input
            ref={picker}
            type="file"
            className="sr-only"
            aria-label="Choose a file to attach"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void upload(file)
            }}
          />
          <Button busy={busy === 'upload'} onClick={() => picker.current?.click()}>
            {busy === 'upload' ? 'Uploading…' : 'Attach a file'}
          </Button>
        </div>
      ) : null}
      </div>
    </section>
  )
}
