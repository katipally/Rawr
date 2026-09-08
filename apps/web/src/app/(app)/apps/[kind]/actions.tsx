'use client'

import { Button, DropdownMenu, Modal, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { IntegrationKind } from '@rawr/db'
import { api, errorMessage } from '~/lib/rpc.ts'
import { integrationsPath } from '~/lib/links.ts'

/** The Actions menu HubSpot puts at the top right of an app page. Disconnecting
 *  is the only thing on it, and it asks first: the credential is shared by every
 *  account in the organisation, so this is not one person's tab that breaks. */
export const AppActions = ({ kind, name }: { kind: IntegrationKind; name: string }) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const disconnect = async () => {
    setBusy(true)
    try {
      await api.integrations.disconnect.mutate({ kind })
      toast('success', `${name} disconnected. Nothing is sent to it any more.`)
      setConfirming(false)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DropdownMenu
        label={`Actions for ${name}`}
        align="end"
        groups={[
          {
            key: 'manage',
            items: [{ key: 'change', label: 'Change the credential', href: integrationsPath(kind) }],
          },
          {
            key: 'danger',
            items: [
              {
                key: 'disconnect',
                label: `Disconnect ${name}`,
                destructive: true,
                onSelect: () => setConfirming(true),
              },
            ],
          },
        ]}
        trigger={(props) => (
          <Button {...props} variant="tertiary">
            Actions
          </Button>
        )}
      />

      <Modal
        open={confirming}
        size="sm"
        title={`Disconnect ${name}`}
        onClose={() => setConfirming(false)}
      >
        <div className="flex flex-col gap-3">
          <p>
            The stored credential is deleted and every account in this organisation stops using{' '}
            {name}. Work already queued for it dead-letters rather than disappearing, so nothing is
            lost, but nothing new is sent either.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" busy={busy} onClick={() => void disconnect()}>
              Disconnect {name}
            </Button>
            <Button variant="tertiary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
