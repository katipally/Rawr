'use client'

import type { BookingKind } from '@rawr/db'
import { Badge, Button, DataTable, Modal, Switch, type Column, useToast } from '@rawr/ui'
import { ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { usePagedRows } from '~/components/paged.tsx'
import { availabilityPath, bookedPath, bookingPagesPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { BookingLinkSnippet } from './snippet.tsx'

export type PageRow = {
  id: string
  ownerId: string | null
  slug: string
  name: string
  kind: BookingKind
  ownerName: string | null
  durationMinutes: number
  location: string
  isActive: boolean
  hostCount: number
  upcoming: number
  unhealthyHosts: number
  hostsWithHours: number
}

const KINDS: Record<BookingKind, string> = {
  one_on_one: 'One-on-one',
  round_robin: 'Round robin',
  collective: 'Collective',
}

const LOCATIONS: Record<string, string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  phone: 'Phone',
  custom: 'Custom',
}

/** HubSpot's scheduling pages table: the name with its public slug under it,
 *  who organises it, the kind, the length, and how many meetings it has ahead.
 *  The link and embed code sit behind one button per row rather than under
 *  every card. */
export const PagesTable = ({
  account,
  baseUrl,
  rows,
  viewer,
}: {
  account: string
  baseUrl: string
  rows: PageRow[]
  /** Who is looking. The switch is only rendered where the data access layer
   *  would actually allow the change: your own page, or any page if you are an
   *  admin. A control that always throws is worse than no control. */
  viewer: { id: string; isAdmin: boolean }
}) => {
  const router = useRouter()
  const toast = useToast()
  const [embedding, setEmbedding] = useState<PageRow | null>(null)
  const { page, pager } = usePagedRows(rows, 'scheduling pages')
  const [pending, setPending] = useState<string | null>(null)

  const setActive = async (row: PageRow, isActive: boolean) => {
    setPending(row.id)
    try {
      await api.booking.setPageActive.mutate({ id: row.id, isActive })
      toast('success', isActive ? `“${row.name}” is taking bookings.` : `“${row.name}” is off.`)
      router.refresh()
    } catch (cause) {
      toast('error', errorMessage(cause))
    } finally {
      setPending(null)
    }
  }

  const columns: Column<PageRow>[] = [
    {
      key: 'name',
      header: 'Meeting name',
      width: 360,
      render: (row) => (
        <span className="flex min-w-0 flex-col py-1">
          <span className="flex min-w-0 items-center gap-2">
            <Link href={bookingPagesPath(account, row.id)} title={row.name} className="truncate font-semibold" onClick={(event) => event.stopPropagation()}>
              {row.name}
            </Link>
            {row.unhealthyHosts > 0 ? <Badge tone="error">{row.unhealthyHosts} without a calendar</Badge> : null}
          </span>
          <a
            href={`${baseUrl}/b/${account}/${row.slug}`}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="inline-flex items-center gap-1 truncate text-small"
          >
            {row.slug}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 130,
      render: (row) => {
        const mayToggle = viewer.isAdmin || row.ownerId === viewer.id
        if (!mayToggle) return row.isActive ? 'On' : <Badge tone="neutral">Off</Badge>
        // Publishing with nobody to meet is refused by the data access layer,
        // so the reason is said here rather than thrown after the click.
        const blocked = !row.isActive && row.hostCount === 0
        // A page with hosts but no working hours publishes fine and then offers a
        // visitor nothing, which reads as a broken link rather than an empty diary.
        // Said here, where the switch is, not only on the availability screen.
        const noHours = row.hostCount > 0 && row.hostsWithHours === 0
        return (
          <span className="flex items-center gap-2">
            <Switch
              label={row.isActive ? `Turn “${row.name}” off` : `Turn “${row.name}” on`}
              hideLabel
              checked={row.isActive}
              disabled={pending === row.id || blocked}
              title={blocked ? 'Add an active host before this page can take bookings.' : undefined}
              onChange={(event) => void setActive(row, event.target.checked)}
            />
            {noHours ? (
              <Link
                href={availabilityPath(account)}
                onClick={(event) => event.stopPropagation()}
                title="No host on this page has working hours, so it offers no times."
              >
                <Badge tone="warn">No hours</Badge>
              </Link>
            ) : null}
          </span>
        )
      },
    },
    { key: 'organizer', header: 'Organizer', width: 180, render: (row) => row.ownerName ?? <span className="text-secondary">--</span> },
    { key: 'type', header: 'Type', width: 130, render: (row) => KINDS[row.kind] },
    { key: 'duration', header: 'Duration', width: 110, render: (row) => `${row.durationMinutes} min` },
    { key: 'where', header: 'Location', width: 130, render: (row) => LOCATIONS[row.location] ?? row.location },
    { key: 'hosts', header: 'Hosts', width: 90, align: 'right', render: (row) => row.hostCount },
    {
      key: 'upcoming',
      header: 'Meetings booked',
      width: 150,
      align: 'right',
      render: (row) => (
        <Link href={bookedPath(account, { page: row.id })} onClick={(event) => event.stopPropagation()}>
          {row.upcoming.toLocaleString()}
        </Link>
      ),
    },
    {
      key: 'embed',
      header: '',
      width: 170,
      render: (row) => (
        <Button
          className="whitespace-nowrap"
          onClick={(event) => {
            event.stopPropagation()
            setEmbedding(row)
          }}
        >
          Link and embed
        </Button>
      ),
    },
  ]

  return (
    <>
      <DataTable columns={columns} rows={page} rowKey={(row) => row.id} caption="Scheduling pages in this account" />
      {pager}
      <Modal open={embedding !== null} title={embedding ? `Share “${embedding.name}”` : 'Share'} onClose={() => setEmbedding(null)}>
        {embedding ? <BookingLinkSnippet baseUrl={baseUrl} account={account} slug={embedding.slug} open /> : null}
      </Modal>
    </>
  )
}
