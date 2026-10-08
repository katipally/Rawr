'use client'

import { IconButton } from '@rawr/ui'
import { Paperclip, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { attachmentTotalError, megabytes } from '~/lib/mail-compose.ts'
import { api, errorMessage } from '~/lib/rpc.ts'

/** Files on a message being written. Each one is uploaded as soon as it is picked,
 *  so by the time Send is pressed the bytes are already in storage and sending only
 *  names them. A file that is taken off, or left behind by closing the composer, is
 *  discarded on the server rather than left as bytes nobody can reach. */

export type Attached = {
  id: string
  name: string
  mime: string
  bytes: number
  storageKey: string | null
  status: 'uploading' | 'ready' | 'failed'
  progress: number
  error: string | null
}

const sizeOf = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${megabytes(bytes)} MB`)

/** The bytes, with progress. A fetch cannot report how much of an upload has gone. */
const send = (
  storageKey: string,
  file: File,
  onProgress: (fraction: number) => void,
  inFlight: Map<string, XMLHttpRequest>,
  id: string,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    inFlight.set(id, request)
    request.open('POST', `/api/attachments/upload?key=${encodeURIComponent(storageKey)}`)
    request.setRequestHeader('content-type', file.type || 'application/octet-stream')
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total)
    }
    request.onload = () => {
      inFlight.delete(id)
      if (request.status >= 200 && request.status < 300) return resolve()
      let refusal = 'That file was refused.'
      try {
        refusal = (JSON.parse(request.responseText) as { error?: string }).error ?? refusal
      } catch {
        // Not JSON: the generic sentence stands.
      }
      reject(new Error(refusal))
    }
    request.onerror = () => {
      inFlight.delete(id)
      reject(new Error('The file did not reach storage. Check the connection and attach it again.'))
    }
    request.onabort = () => {
      inFlight.delete(id)
      reject(new Error('The upload was stopped.'))
    }
    request.send(file)
  })

/** The list of files on one message, and the uploads behind it. `add` returns the
 *  sentence to show when the picked files would take the message over its limit,
 *  and starts nothing in that case. */
export const useAttachments = () => {
  const [files, setFiles] = useState<Attached[]>([])
  const inFlight = useRef(new Map<string, XMLHttpRequest>())
  const removed = useRef(new Set<string>())

  const patch = (id: string, change: Partial<Attached>) =>
    setFiles((rows) => rows.map((row) => (row.id === id ? { ...row, ...change } : row)))

  const upload = async (id: string, file: File) => {
    try {
      const { storageKey } = await api.mail.attachments.begin.mutate({ filename: file.name, bytes: file.size })
      if (removed.current.has(id)) {
        await api.mail.attachments.discard.mutate({ storageKey }).catch(() => undefined)
        return
      }
      patch(id, { storageKey })
      await send(storageKey, file, (progress) => patch(id, { progress }), inFlight.current, id)
      if (!removed.current.has(id)) patch(id, { status: 'ready', progress: 1 })
    } catch (cause) {
      if (!removed.current.has(id)) patch(id, { status: 'failed', error: errorMessage(cause) })
    }
  }

  const add = (picked: File[], current: Attached[]): string | null => {
    const total = current.reduce((sum, row) => sum + row.bytes, 0) + picked.reduce((sum, file) => sum + file.size, 0)
    const error = attachmentTotalError(total)
    if (error) return error
    for (const file of picked) {
      const id = crypto.randomUUID()
      setFiles((rows) => [
        ...rows,
        { id, name: file.name, mime: file.type, bytes: file.size, storageKey: null, status: 'uploading', progress: 0, error: null },
      ])
      void upload(id, file)
    }
    return null
  }

  const remove = (id: string) => {
    removed.current.add(id)
    inFlight.current.get(id)?.abort()
    inFlight.current.delete(id)
    const row = files.find((item) => item.id === id)
    setFiles((rows) => rows.filter((item) => item.id !== id))
    if (row?.storageKey) void api.mail.attachments.discard.mutate({ storageKey: row.storageKey }).catch(() => undefined)
  }

  /** Every file still on the message, for closing without sending. */
  const discardAll = () => {
    for (const row of files) {
      removed.current.add(row.id)
      inFlight.current.get(row.id)?.abort()
      if (row.storageKey) void api.mail.attachments.discard.mutate({ storageKey: row.storageKey }).catch(() => undefined)
    }
  }

  return {
    files,
    add: (picked: File[]) => add(picked, files),
    remove,
    discardAll,
    busy: files.some((row) => row.status === 'uploading'),
    failed: files.some((row) => row.status === 'failed'),
    ready: files.flatMap((row) =>
      row.status === 'ready' && row.storageKey ? [{ storageKey: row.storageKey, filename: row.name, mime: row.mime }] : [],
    ),
  }
}

export const AttachmentList = ({ files, onRemove }: { files: Attached[]; onRemove: (id: string) => void }) => (
  <ul className="flex min-w-0 flex-col gap-1" aria-label="Attached files">
    {files.map((row) => (
      <li key={row.id} className="flex min-w-0 items-center gap-2 rounded-hs border border-line px-2 py-1">
        <Paperclip aria-hidden="true" className="size-3.5 shrink-0 text-secondary" />
        <span className="min-w-0 flex-1 truncate" title={row.name}>
          {row.name}
        </span>
        <span className={row.status === 'failed' ? 'min-w-0 shrink text-error' : 'shrink-0 text-secondary'} role={row.status === 'failed' ? 'alert' : undefined}>
          {row.status === 'uploading'
            ? `Uploading ${Math.round(row.progress * 100)}%`
            : row.status === 'failed'
              ? row.error
              : sizeOf(row.bytes)}
        </span>
        <IconButton label={`Remove ${row.name}`} icon={<X aria-hidden="true" className="size-3.5" />} onClick={() => onRemove(row.id)} />
      </li>
    ))}
  </ul>
)
