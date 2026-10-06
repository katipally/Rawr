'use client'

import type { BookingKind } from '@rawr/db'
import { Button, Field, Modal, TextInput, cn, useToast } from '@rawr/ui'
import { Shuffle, User, Users } from 'lucide-react'
import { useNavigation } from '~/components/navigation.tsx'
import { useState, type ComponentType } from 'react'
import { api, errorMessage } from '~/lib/rpc.ts'
import { bookingPagesPath } from '~/lib/links.ts'
import { replaceParams } from '~/lib/url-params.ts'

/** HubSpot's "Choose a scheduling page type": three cards, then the editor.
 *  Between the two this asks for the one thing that cannot be defaulted, the
 *  name the public link is made from. Everything else opens in the editor with
 *  the production configuration already in it, so a new page is bookable before
 *  anybody changes a setting. */

const TYPES: { kind: BookingKind; title: string; hint: string; Icon: ComponentType<{ className?: string }> }[] = [
  { kind: 'one_on_one', title: 'One-on-one', hint: 'Contacts book a meeting with you alone. Only you can see and change it.', Icon: User },
  { kind: 'collective', title: 'Group', hint: 'Contacts book a meeting with several people on your team, all free at once.', Icon: Users },
  { kind: 'round_robin', title: 'Round robin', hint: 'Meetings are shared out across your team, to whoever is furthest behind.', Icon: Shuffle },
]

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

  titleTpl: 'Discovery Session with {{company.name}}',
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
  const [kind, setKind] = useState<BookingKind | null>(null)
  const [saving, setSaving] = useState(false)

  const close = () => {
    setOpen(false)
    setKind(null)
    setName('')
    replaceParams({ new: null })
  }

  const slug = slugify(name)

  const create = async () => {
    if (!kind) return
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

      <Modal
        open={open}
        onClose={close}
        size="lg"
        title={kind === null ? 'Choose a scheduling page type' : `New ${TYPES.find((type) => type.kind === kind)?.title} page`}
        dirty={name !== ''}
        {...(kind === null
          ? {}
          : {
              onSubmit: () => void create(),
              footer: (
                <>
                  <Button type="button" onClick={() => setKind(null)}>
                    Choose another type
                  </Button>
                  <Button variant="primary" type="submit" busy={saving} disabled={name.trim() === ''}>
                    {saving ? 'Creating…' : 'Create'}
                  </Button>
                </>
              ),
            })}
      >
        {kind === null ? (
          <div className="flex min-w-0 flex-col gap-3">
            <ul className="grid min-w-0 gap-3 sm:grid-cols-3">
              {TYPES.map(({ kind: option, title, hint, Icon }) => {
                const locked = option !== 'one_on_one' && !canCreateShared
                return (
                  <li key={option} className="min-w-0">
                    <button
                      type="button"
                      disabled={locked}
                      onClick={() => setKind(option)}
                      className={cn(
                        'flex h-full w-full min-w-0 flex-col items-center gap-3 rounded-hs border border-line-strong bg-surface p-5 text-center transition-all duration-150 ease-out',
                        'hover:bg-fill active:bg-fill disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-surface',
                      )}
                    >
                      <span aria-hidden="true" className="grid size-16 place-items-center rounded-pill bg-accent-subtle text-link">
                        <Icon className="size-7" />
                      </span>
                      <span className="text-base font-semibold">{title}</span>
                      <span>{hint}</span>
                      {locked ? <span className="text-small text-secondary">Shared pages are an admin's to set up.</span> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ) : (
          <Field
            id="new-booking-name"
            label="Internal name"
            required
            hint={slug ? `Will be booked at /b/${account}/${slug}` : 'Used for the public link'}
          >
            <TextInput
              id="new-booking-name"
              value={name}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              placeholder={kind === 'one_on_one' ? 'Meet with me' : 'Sales team round robin'}
            />
          </Field>
        )}
      </Modal>
    </>
  )
}
