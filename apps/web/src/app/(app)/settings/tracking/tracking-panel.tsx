'use client'

import { Button, Card, Field, TextInput, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

export const TrackingPanel = ({ domain }: { domain: string | null }) => {
  const router = useRouter()
  const toast = useToast()
  const [value, setValue] = useState(domain ?? '')
  const [busy, setBusy] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <Card title="Where the links point">
        <div className="flex flex-col gap-3">
          <Field
            label="Hostname"
            id="tracking-domain"
            hint="Leave it empty to use this app's own address. That works, and it is not what you want for real outreach: mail carrying links on your app domain is what gets that domain classified as bulk."
          >
            <TextInput
              id="tracking-domain"
              placeholder="links.datasaur.ai"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </Field>
          <div>
            <Button
              variant="primary"
              busy={busy}
              disabled={value.trim() === (domain ?? '')}
              onClick={() => {
                setBusy(true)
                void api.sequences.tracking.set
                  .mutate({ domain: value.trim() || null })
                  .then(() => {
                    toast('success', 'Saved. New sends use it; anything already out keeps the old links.')
                    router.refresh()
                  })
                  .catch((cause) => toast('error', errorMessage(cause)))
                  .finally(() => setBusy(false))
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </Card>

      <Card title="What to set up">
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-secondary">
          <li>
            Add a CNAME for <code className="text-body">{value.trim() || 'links.yourdomain.com'}</code> pointing at
            this app's host, so the certificate covers it.
          </li>
          <li>Point it here, and confirm the address opens this app rather than a certificate warning.</li>
          <li>
            Keep it on the same domain you send from. A tracking host on a different domain than the
            sender is one of the strongest spam signals there is.
          </li>
        </ol>
      </Card>
    </div>
  )
}
