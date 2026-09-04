'use client'

import { Button, Field, Select, TextInput, useToast } from '@rawr/ui'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

/** A push is the one write this screen makes, and it is keyed on the segment and
 *  the members it has right now, so pressing it twice does not double a list. */
export const NewsletterPanel = ({
  segments,
  defaultListId,
  canWrite,
  role,
}: {
  segments: { id: string; name: string }[]
  defaultListId: string
  canWrite: boolean
  role: string
}) => {
  const toast = useToast()
  const [segmentId, setSegmentId] = useState(segments[0]?.id ?? '')
  const [listId, setListId] = useState(defaultListId)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  if (!canWrite) {
    return (
      <p className="text-secondary">
        Your role ({role}) can see the newsletter's health and cannot push an audience to Brevo.
      </p>
    )
  }

  if (segments.length === 0) {
    return (
      <p className="text-secondary">
        There are no contact segments yet. A segment is a saved query, and it is what a push sends.
      </p>
    )
  }

  const push = async () => {
    setBusy(true)
    setResult(null)
    try {
      const outcome = await api.integrations.pushSegment.mutate({ segmentId, listId: Number(listId) })
      setResult(
        `${outcome.pushed} pushed to list ${outcome.listId ?? listId}, ${outcome.skipped} left out: opted out, or no address on the record.`,
      )
      toast('success', 'Pushed to Brevo.')
    } catch (cause) {
      const message = errorMessage(cause)
      setResult(message)
      toast('error', message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="max-w-prose text-secondary">
        Everybody in the segment who has not opted out of the newsletter is upserted into the Brevo
        list, keyed on their address. Anybody who has opted out is left out, whatever Brevo thinks.
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field id="newsletter-segment" label="Segment">
            <Select id="newsletter-segment" value={segmentId} onChange={(event) => setSegmentId(event.target.value)}>
              {segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field id="newsletter-list" label="Brevo list id" hint="Blank uses the one configured on the integration.">
          <TextInput
            id="newsletter-list"
            inputMode="numeric"
            value={listId}
            onChange={(event) => setListId(event.target.value.replace(/[^0-9]/g, ''))}
          />
        </Field>

        <Button variant="primary" busy={busy} disabled={!segmentId || listId === ''} onClick={() => void push()}>
          Push to Brevo
        </Button>
      </div>

      {result ? (
        <p role="status" className="text-secondary">
          {result}
        </p>
      ) : null}
    </div>
  )
}
