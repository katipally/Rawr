'use client'

import { create } from 'zustand'
import { api, errorMessage } from '~/lib/rpc.ts'

/** Files on their way to storage.
 *
 *  The loop lives here rather than in the form because a store outlives the
 *  screen that started it: somebody can upload an eighty megabyte export, walk off
 *  to the contacts list and watch it finish in the tray. Only closing the tab
 *  stops it, and the server remembers enough that closing the tab is survivable
 *  too -- the parts that landed are kept, and the same file picked again carries
 *  on from where it stopped.
 *
 *  What is not here is the `File` itself. It cannot be serialised, and the handle
 *  dies with the page, so persisting any of this would be persisting a promise
 *  the app could not keep. The durable record is the run, in the database. */

export type UploadState = 'sending' | 'sealing' | 'done' | 'stopped' | 'failed'

export type Upload = {
  runId: string
  accountSlug: string
  filename: string
  /** The file's size, and how much of it storage has acknowledged. */
  bytes: number
  sent: number
  state: UploadState
  error: string | null
}

/** Sent again this many times before the upload gives up on a part. A part lands
 *  once however often it is sent, because it is placed by number. */
const ATTEMPTS = 3

/** The `File` behind each upload, and whether somebody asked it to stop. Outside
 *  the store because neither belongs in a render. */
const files = new Map<string, File>()
const stopped = new Set<string>()

class Stopped extends Error {}

const withRetry = async <T>(send: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send()
    } catch (cause) {
      if (attempt >= ATTEMPTS) throw cause
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
    }
  }
}

const sendPart = async (runId: string, n: number, blob: Blob): Promise<{ uploadedBytes: number }> => {
  const response = await fetch(`/api/imports/part?id=${encodeURIComponent(runId)}&n=${n}`, {
    method: 'POST',
    body: blob,
    headers: { 'content-type': 'application/octet-stream' },
  })
  const answer = (await response.json().catch(() => ({}))) as { error?: string; uploadedBytes?: number }
  if (!response.ok) throw new Error(answer.error ?? `That part was refused (${response.status}).`)
  return { uploadedBytes: answer.uploadedBytes ?? 0 }
}

type UploadStore = {
  uploads: Upload[]
  /** A new file. Resolves with the run's id as soon as the run exists, which is
   *  one round trip: the bytes go afterwards, from here, so the page is free to
   *  navigate to the run and watch rather than to sit on the form. */
  begin: (input: {
    accountSlug: string
    file: File
    what: string
    source: string | null
  }) => Promise<string>
  /** An upload from an earlier visit, given the same file again. `have` is the
   *  parts storage already holds, and `partBytes` the size it holds them in; both
   *  come from the run, so the browser never decides either. */
  resume: (input: {
    accountSlug: string
    runId: string
    file: File
    have: number[]
    partBytes: number
    sent: number
  }) => string
  stop: (runId: string) => void
  dismiss: (runId: string) => void
}

export const useUploads = create<UploadStore>()((set, get) => {
  const put = (runId: string, patch: Partial<Upload>) =>
    set((state) => ({
      uploads: state.uploads.map((row) => (row.runId === runId ? { ...row, ...patch } : row)),
    }))

  /** The parts, in order, skipping the ones storage already has. Part `n` is
   *  always the same byte range, which is what makes "which are missing"
   *  answerable from the numbers alone. */
  const push = async (runId: string, file: File, partBytes: number, have: Set<number>): Promise<void> => {
    const total = Math.max(1, Math.ceil(file.size / partBytes))
    for (let n = 1; n <= total; n += 1) {
      if (stopped.has(runId)) throw new Stopped()
      if (have.has(n)) continue
      const from = (n - 1) * partBytes
      const { uploadedBytes } = await withRetry(() => sendPart(runId, n, file.slice(from, from + partBytes)))
      put(runId, { sent: uploadedBytes })
    }
  }

  const carry = async (runId: string, file: File, partBytes: number, have: Set<number>): Promise<string> => {
    try {
      await push(runId, file, partBytes, have)
      put(runId, { state: 'sealing' })
      // The server reads the file from here. Closing the tab now costs nothing.
      await withRetry(() => api.crm.imports.finishUpload.mutate({ id: runId }))
      put(runId, { state: 'done', sent: file.size })
      return runId
    } catch (cause) {
      const quit = cause instanceof Stopped
      if (quit) await api.crm.imports.discardUpload.mutate({ id: runId }).catch(() => undefined)
      put(runId, { state: quit ? 'stopped' : 'failed', error: quit ? null : errorMessage(cause) })
      throw cause
    } finally {
      files.delete(runId)
      stopped.delete(runId)
    }
  }

  return {
    uploads: [],

    begin: async ({ accountSlug, file, what, source }) => {
      const { id, partBytes } = await api.crm.imports.beginUpload.mutate({
        what,
        source,
        filename: file.name,
        fileBytes: file.size,
      })
      files.set(id, file)
      set((state) => ({
        uploads: [
          { runId: id, accountSlug, filename: file.name, bytes: file.size, sent: 0, state: 'sending', error: null },
          ...state.uploads,
        ],
      }))
      void carry(id, file, partBytes, new Set()).catch(() => {
        // Recorded on the upload itself, which is what the tray and the run page
        // both read. Nothing is waiting on this promise.
      })
      return id
    },

    resume: ({ accountSlug, runId, file, have, partBytes, sent }) => {
      files.set(runId, file)
      stopped.delete(runId)
      set((state) => ({
        uploads: [
          { runId, accountSlug, filename: file.name, bytes: file.size, sent, state: 'sending', error: null },
          ...state.uploads.filter((row) => row.runId !== runId),
        ],
      }))
      void carry(runId, file, partBytes, new Set(have)).catch(() => {
        // Same: the upload carries its own failure.
      })
      return runId
    },

    stop: (runId) => {
      stopped.add(runId)
      // Between parts is the soonest the loop can notice, so the button says so
      // straight away rather than looking dead for a part's worth of time.
      if (get().uploads.some((row) => row.runId === runId && row.state === 'sending')) {
        put(runId, { state: 'stopped' })
      }
    },

    dismiss: (runId) => set((state) => ({ uploads: state.uploads.filter((row) => row.runId !== runId) })),
  }
})
