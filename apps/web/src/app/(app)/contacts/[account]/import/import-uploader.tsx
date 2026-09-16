'use client'

import { Alert, Button, Field, Select } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { formatNumber } from '~/components/crm/value.tsx'
import { importsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useUploads } from '~/lib/store/uploads.ts'
import { ImportKindField, type ImportKindOption } from './import-kind-field.tsx'

/** An upload that never finished, offered back. The file itself cannot be kept --
 *  a browser will not hand the same one over without somebody choosing it -- so
 *  what is offered is the part of it that did land, and picking the file again
 *  sends only what is missing. */
type Unfinished = {
  id: string
  filename: string
  fileBytes: number
  uploadedBytes: number
  have: number[]
  partBytes: number
}

const percent = (sent: number, total: number): number =>
  total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0

const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** Picks the file and sends it to storage, a part at a time.
 *
 *  The browser does not read the file. It pushes bytes and stops, and the server
 *  opens the object and reads it into rows, which is why an import is now over in
 *  the time the upload takes rather than an hour after it. The pushing is the
 *  store's rather than this component's, so walking off this page does not stop
 *  it -- and a part is numbered, so closing the tab entirely does not lose what
 *  already landed. */
export const ImportUploader = ({ account, kinds }: { account: string; kinds: ImportKindOption[] }) => {
  const router = useRouter()
  const begin = useUploads((state) => state.begin)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [unfinished, setUnfinished] = useState<Unfinished[]>([])

  useEffect(() => {
    let dropped = false
    api.crm.imports.unfinished
      .query()
      .then((rows) => {
        if (!dropped) setUnfinished(rows)
      })
      .catch(() => {
        // Nothing here depends on the offer; the form works without it.
      })
    return () => {
      dropped = true
    }
  }, [])

  const upload = async (form: HTMLFormElement) => {
    const data = new FormData(form)
    const file = data.get('file')
    if (!(file instanceof File) || file.size === 0) {
      setError('Pick a file to import.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const id = await begin({
        accountSlug: account,
        file,
        what: String(data.get('object') ?? ''),
        source: String(data.get('source') ?? '') || null,
      })
      // Straight to the run, which shows the upload and then the mapper. The
      // bytes are still going, from the store, and leaving this page is fine.
      router.push(importsPath(account, id))
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {unfinished.map((run) => (
        <ResumeCard
          key={run.id}
          account={account}
          run={run}
          onGone={() => setUnfinished((rows) => rows.filter((row) => row.id !== run.id))}
        />
      ))}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          void upload(event.currentTarget)
        }}
        className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-6 shadow-panel"
      >
        <h2 className="text-base font-semibold">Import a file</h2>
        <p className="text-secondary">One-time import from a file, directly into the CRM.</p>
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
          <ImportKindField options={kinds} />

          <Field
            id="import-source"
            label="Where it came from"
            hint="A HubSpot export is mapped for you: its column names are matched to Rawr's fields, and the columns that mean nothing here are dismissed. Importing the same export twice changes nothing."
          >
            <Select id="import-source" name="source" defaultValue="">
              <option value="">A file I put together</option>
              <option value="hubspot">A HubSpot export</option>
            </Select>
          </Field>

          <Field
            id="import-file"
            label="File"
            hint="CSV or XLSX, any size. The file is uploaded and read here, so you can close the tab once it has arrived. Nothing is written until you have seen the preview."
          >
            <input
              id="import-file"
              name="file"
              type="file"
              required
              accept=".csv,.tsv,.txt,.xlsx"
              className="w-full min-w-0 rounded-hs border border-line bg-fill px-3 py-1.5"
            />
          </Field>
        </fieldset>

        {error ? <Alert>{error}</Alert> : null}

        <div>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Starting…' : 'Upload and map columns'}
          </Button>
        </div>
      </form>
    </div>
  )
}

/** One unfinished upload. The same file, chosen again, carries on; a different
 *  one is refused rather than stitched onto the half that is there. */
const ResumeCard = ({
  account,
  run,
  onGone,
}: {
  account: string
  run: Unfinished
  onGone: () => void
}) => {
  const router = useRouter()
  const resume = useUploads((state) => state.resume)
  const picker = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  const chosen = (file: File | undefined) => {
    if (!file) return
    if (file.size !== run.fileBytes) {
      setError(`That is not the same file: ${run.filename} was ${megabytes(run.fileBytes)}.`)
      return
    }
    resume({
      accountSlug: account,
      runId: run.id,
      file,
      have: run.have,
      partBytes: run.partBytes,
      sent: run.uploadedBytes,
    })
    router.push(importsPath(account, run.id))
  }

  const discard = async () => {
    await api.crm.imports.discardUpload.mutate({ id: run.id }).catch(() => undefined)
    onGone()
  }

  return (
    <div className="flex flex-col gap-3 rounded-panel border border-line bg-surface p-6 shadow-panel">
      <h2 className="text-base font-semibold">Carry on uploading {run.filename}?</h2>
      <p className="text-secondary">
        {percent(run.uploadedBytes, run.fileBytes)}% of it is here ({megabytes(run.uploadedBytes)} of{' '}
        {megabytes(run.fileBytes)}, {formatNumber(run.have.length)} parts). Choose the same file again and the rest
        goes; nothing that arrived is sent twice.
      </p>
      {error ? <Alert>{error}</Alert> : null}
      <input
        ref={picker}
        type="file"
        accept=".csv,.tsv,.txt,.xlsx"
        className="sr-only"
        onChange={(event) => chosen(event.currentTarget.files?.[0])}
      />
      <div className="flex gap-2">
        <Button variant="primary" onClick={() => picker.current?.click()}>
          Choose the file again
        </Button>
        <Button onClick={() => void discard()}>Throw it away</Button>
      </div>
    </div>
  )
}
