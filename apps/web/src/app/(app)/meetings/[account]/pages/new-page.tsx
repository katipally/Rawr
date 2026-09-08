'use client'

import type { BookingKind } from '@rawr/db'
import { Button, Field, Modal, Select, TextInput, useToast } from '@rawr/ui'
import { useNavigation } from '~/components/navigation.tsx'
import { useState } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { bookingPagesPath } from '~/lib/links.ts'

/** Creating a page asks for the two things that cannot be defaulted: what it is
 *  called and, for an admin, whether it is shared. Everything else opens in the
 *  editor with the production configuration already in it, so a new page is
 *  bookable before anybody changes a setting. */

const KIND_HINTS: Record<BookingKind, string> = {
  round_robin: 'Spreads meetings across a team. Embedded on the website.',
  collective: 'Everybody listed has to be free, and all of them are on the invitation.',
  one_on_one: 'Yours alone, for an email signature. Only you can see and change it.',
}

const DEFAULTS = {
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 15,
  minNoticeMinutes: 240,
  maxHorizonDays: 60,
  granularityMinutes: 30,
  // location is not here: what works depends on the deployment, so it is passed
  // in rather than assumed. Defaulting to Zoom on a deployment with no Zoom app
  // made every new page confirm meetings with no link in them.

  titleTpl: 'Discovery Session with Datasaur <> {{company.name}}',
  descriptionTpl: '{{contact.first_name}} {{contact.last_name}} {{contact.email}}\n{{company.name}}',
  companyFallback: 'a new team',
}

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)

export const NewPageButton = ({
  defaultLocation,
  account,
  canCreateShared,
  startOpen = false,
}: {
  account: string
  canCreateShared: boolean
  /** The Create menu links straight here, so the dialog opens on arrival rather
   *  than landing somebody on a list and asking them to find the button. */
  startOpen?: boolean
  /** The first conferencing option this deployment can actually produce a link
   *  for, or 'phone' when it can produce none. */
  defaultLocation: 'zoom' | 'google_meet' | 'phone'
}) => {
  const { navigate } = useNavigation()
  const show = useToast()
  const [open, setOpen] = useState(startOpen)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<BookingKind>(canCreateShared ? 'round_robin' : 'one_on_one')
  const [saving, setSaving] = useState(false)

  const slug = slugify(name)

  const create = async () => {
    if (!slug) {
      show('error', 'A page needs a name with at least one letter or number in it.')
      return
    }
    setSaving(true)
    try {
      const id = await api.booking.savePage.mutate({
        ...DEFAULTS,
        location: defaultLocation,
        slug,
        name: name.trim(),
        kind,
        questions: [],
        // A new page starts unpublished: a round robin with no hosts cannot be
        // published at all, and nobody wants a half-configured link live.
        isActive: false,
        ...(kind === 'one_on_one' ? {} : { hosts: [] }),
      })
      navigate(bookingPagesPath(account, id))
    } catch (cause) {
      show('error', errorMessage(cause))
      setSaving(false)
    }
  }

  return (
    <>
      <Button variant="primary" type="button" onClick={() => setOpen(true)}>
        Create scheduling page
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="New meeting page">
        <div className="flex flex-col gap-3">
          <Field
            id="new-booking-name"
            label="Name"
            required
            hint={slug ? `Will be booked at /b/${account}/${slug}` : 'Used for the public link'}
          >
            <TextInput
              id="new-booking-name"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              placeholder="Sales team round robin"
            />
          </Field>

          {canCreateShared ? (
            <Field
              id="new-booking-kind"
              label="Kind"
              hint={KIND_HINTS[kind]}
            >
              <Select
                id="new-booking-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as typeof kind)}
              >
                <option value="round_robin">Shared round robin</option>
                <option value="collective">Shared collective</option>
                <option value="one_on_one">My personal link</option>
              </Select>
            </Field>
          ) : (
            <p className="text-xs text-secondary">
              This will be your own personal link. Creating a shared round robin page is an admin
              task.
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="button" busy={saving} onClick={() => void create()}>
              {saving ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
