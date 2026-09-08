'use client'

import { Button, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'

/** An address on the thread that nobody in the CRM owns.
 *
 *  Ingest deliberately does not create a contact for every stranger who ever
 *  wrote in: that fills the CRM with delivery robots and mailing lists. It does
 *  mean the one address a salesperson actually wants is sitting there as plain
 *  text, and this is the button that fixes that, once, on purpose. */
export const AddParticipant = ({ address }: { address: string }) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  return (
    <Button
      variant="tertiary"
      busy={busy}
      onClick={() => {
        setBusy(true)
        void api.crm.records.create
          .mutate({ object: 'contact', values: { email: address } })
          .then(async (created) => {
            // The mail is already stored; this is what puts it on the new record,
            // so the history is there the moment the contact is.
            const attached = await api.mail.attachContact.mutate({ contactId: created.id })
            toast(
              'success',
              attached.messages > 0
                ? `${address} is a contact now, carrying ${attached.messages} message${attached.messages === 1 ? '' : 's'}.`
                : `${address} is a contact now.`,
            )
            router.refresh()
            return created
          })
          .catch((cause) => toast('error', errorMessage(cause)))
          .finally(() => setBusy(false))
      }}
    >
      Create contact
    </Button>
  )
}
