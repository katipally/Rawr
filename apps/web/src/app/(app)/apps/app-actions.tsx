'use client'

import { Button, DropdownMenu, Modal, useToast } from '@rawr/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import type { IntegrationKind } from '@rawr/db'
import { api, errorMessage } from '~/lib/rpc.ts'
import { appPath } from '~/lib/links.ts'

export type AppActionsProps = {
  kind: IntegrationKind
  name: string
  /** A personal app has no shared credential to test or disconnect; the only
   *  thing to do from here is go where each person connects their own. */
  personal: boolean
  /** Where a personal app is connected: Mailboxes, or Calendars. */
  connectPath: string
  canManage: boolean
  /** A row's menu says "Actions" like HubSpot's; the page's own can be quieter. */
  variant?: 'secondary' | 'tertiary'
}

/** The Actions menu HubSpot puts on every row of Connected Apps and at the top of
 *  an app's page: go to its settings, check it, or uninstall it. Disconnecting
 *  asks first, because the credential is shared by every account here. */
export const AppActions = ({ kind, name, personal, connectPath, canManage, variant = 'secondary' }: AppActionsProps) => {
  const router = useRouter()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const test = async () => {
    setBusy(true)
    try {
      const outcome = await api.integrations.test.mutate({ kind })
      toast(outcome.ok ? 'success' : 'error', outcome.detail)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

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

  const manage = personal
    ? [{ key: 'connect', label: 'Manage connections', href: connectPath }]
    : [
        { key: 'settings', label: 'Go to settings', href: appPath(kind, 'settings') },
        ...(canManage ? [{ key: 'test', label: 'Test connection', onSelect: () => void test() }] : []),
      ]

  return (
    <>
      <DropdownMenu
        label={`Actions for ${name}`}
        align="end"
        groups={[
          { key: 'manage', items: manage },
          ...(canManage && !personal
            ? [
                {
                  key: 'danger',
                  items: [
                    { key: 'disconnect', label: 'Disconnect', destructive: true, onSelect: () => setConfirming(true) },
                  ],
                },
              ]
            : []),
        ]}
        trigger={(props) => (
          <Button {...props} variant={variant} busy={busy}>
            Actions
          </Button>
        )}
      />

      <Modal
        open={confirming}
        size="sm"
        title={`Disconnect ${name}`}
        onClose={() => setConfirming(false)}
        footer={
          <>
            <Button variant="tertiary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="destructive" busy={busy} onClick={() => void disconnect()}>
              Disconnect {name}
            </Button>
          </>
        }
      >
        <p>
          The stored credential is deleted and everybody in this account stops using {name}. Work
          already queued for it dead-letters rather than disappearing, so nothing is lost, but
          nothing new is sent either.
        </p>
      </Modal>
    </>
  )
}
