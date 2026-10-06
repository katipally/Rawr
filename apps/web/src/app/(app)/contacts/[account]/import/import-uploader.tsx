'use client'

import { Alert, Button, Field, Select } from '@rawr/ui'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { importsPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { useUploads } from '~/lib/store/uploads.ts'
import { ImportKindField, type ImportKindOption } from './import-kind-field.tsx'
import { useFormat } from '~/components/zone.tsx'
import { ImportFrame, stepPill } from '~/components/crm/import-frame.tsx'

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

/** The wizard's first two steps: what the file holds and where it came from,
 *  then the file. Both choices live in the address, so a reload or a Back lands
 *  on the same step with the same tiles ticked; only the file has to be picked
 *  again, because a browser will not hand one over without somebody choosing it.
 *
 *  The browser does not read the file. It pushes bytes and stops, and the server
 *  opens the object and reads it into rows, which is why an import is now over in
 *  the time the upload takes rather than an hour after it. The pushing is the
 *  store's rather than this component's, so walking off this page does not stop
 *  it -- and a part is numbered, so closing the tab entirely does not lose what
 *  already landed. */
export const NewImport = ({ account, kinds }: { account: string; kinds: ImportKindOption[] }) => {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const begin = useUploads((state) => state.begin)
  const fmt = useFormat()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [file, setFile] = useState<File | null>(null)

  const asked = params.get('object')
  const object = kinds.some((kind) => kind.value === asked) ? (asked as string) : (kinds[0]?.value ?? '')
  const source = params.get('source') === 'hubspot' ? 'hubspot' : ''
  const uploading = params.get('step') === 'upload'

  const go = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value)
      else next.delete(key)
    }
    // Shallow: the step and the tiles are this component's, so there is no
    // server render to wait for between a click and the tile it ticks.
    window.history.replaceState(null, '', `${pathname}?${next.toString()}`)
  }

  const upload = async () => {
    if (!file || file.size === 0) {
      setError('Pick a file to import.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const id = await begin({ accountSlug: account, file, what: object, source: source || null })
      // Straight to the run, which shows the upload and then the mapper. The
      // bytes are still going, from the store, and leaving this page is fine.
      router.push(importsPath(account, id))
    } catch (cause) {
      setError(errorMessage(cause))
      setBusy(false)
    }
  }

  return (
    <ImportFrame
      step={uploading ? 1 : 0}
      cancelHref={importsPath(account)}
      back={
        uploading ? (
          <Button className={stepPill} disabled={busy} onClick={() => go({ step: '' })}>
            Back
          </Button>
        ) : undefined
      }
      next={
        <>
          <span className="hidden text-small text-secondary sm:inline">Tip: press Enter to continue</span>
          <Button type="submit" form="import-step" variant="primary" className={stepPill} busy={busy}>
            {busy ? 'Starting…' : 'Next'}
          </Button>
        </>
      }
    >
      <form
        id="import-step"
        className="flex min-w-0 flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault()
          if (uploading) void upload()
          else go({ step: 'upload' })
        }}
      >
        <div className="flex flex-col gap-2 text-center">
          <h2 className="text-2xl font-normal">{uploading ? 'Upload your file' : 'What kind of data is in your file?'}</h2>
          <p className="text-secondary">
            {uploading
              ? 'Nothing is written until you have seen the preview, and you can close the tab once the file has arrived.'
              : 'Records, or the shape around them. For a migration, properties first, then records, then everything that points at a record.'}
          </p>
        </div>

        {uploading ? (
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2 text-base font-semibold">
              {kinds.find((kind) => kind.value === object)?.label ?? 'Records'} file
            </legend>
            <label className="relative flex min-h-[7.5rem] cursor-pointer flex-col items-center justify-center gap-1 rounded-hs border border-dashed border-line-strong bg-fill p-4 text-center transition-colors duration-150 ease-out hover:bg-fill-hover focus-within:border-line-interactive">
              <input
                name="file"
                type="file"
                aria-label="File to import"
                required
                accept=".csv,.tsv,.txt,.xlsx"
                onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
              {file ? (
                <>
                  <span className="max-w-full break-all font-semibold">{file.name}</span>
                  <span className="text-secondary tabular-nums">{fmt.bytes(file.size)}. Choose or drop another to replace it.</span>
                </>
              ) : (
                <>
                  <span>
                    Drag and drop or <span className="font-semibold text-link">choose a file</span>
                  </span>
                  <span className="text-secondary">CSV, TSV, TXT or XLSX, any size.</span>
                </>
              )}
            </label>
          </fieldset>
        ) : (
          <>
            <ImportKindField options={kinds} value={object} onChange={(value) => go({ object: value })} />
            <Field
              id="import-source"
              label="Where it came from"
              hint="A HubSpot export is mapped for you: its column names are matched to Rawr's fields, and the columns that mean nothing here are dismissed. Importing the same export twice changes nothing."
            >
              <Select id="import-source" value={source} onChange={(event) => go({ source: event.target.value })}>
                <option value="">A file I put together</option>
                <option value="hubspot">A HubSpot export</option>
              </Select>
            </Field>
          </>
        )}

        {error ? <Alert>{error}</Alert> : null}
      </form>
    </ImportFrame>
  )
}

/** Uploads that never finished, each offered back on the imports list. */
export const UnfinishedUploads = ({ account }: { account: string }) => {
  const [unfinished, setUnfinished] = useState<Unfinished[]>([])

  useEffect(() => {
    let dropped = false
    api.crm.imports.unfinished
      .query()
      .then((rows) => {
        if (!dropped) setUnfinished(rows)
      })
      .catch(() => {
        // Nothing here depends on the offer; the page works without it.
      })
    return () => {
      dropped = true
    }
  }, [])

  return unfinished.map((run) => (
    <ResumeCard
      key={run.id}
      account={account}
      run={run}
      onGone={() => setUnfinished((rows) => rows.filter((row) => row.id !== run.id))}
    />
  ))
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
  const fmt = useFormat()
  const router = useRouter()
  const resume = useUploads((state) => state.resume)
  const picker = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  const chosen = (file: File | undefined) => {
    if (!file) return
    if (file.size !== run.fileBytes) {
      setError(`That is not the same file: ${run.filename} was ${fmt.bytes(run.fileBytes)}.`)
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
        {percent(run.uploadedBytes, run.fileBytes)}% of it is here: {fmt.bytes(run.uploadedBytes)} of{' '}
        {fmt.bytes(run.fileBytes)}, in {run.have.length === 1 ? '1 piece' : `${fmt.number(run.have.length)} pieces`}.
        Choose the same file again and the rest goes; nothing that arrived is sent twice.
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
