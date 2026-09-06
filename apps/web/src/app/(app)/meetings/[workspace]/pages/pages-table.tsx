'use client'

import { Badge, DataTable, Modal, type Column } from '@rawr/ui'
import { ExternalLink } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import { bookedPath, bookingPagesPath } from '~/lib/links.ts'
import { BookingLinkSnippet } from './snippet.tsx'

export type PageRow = {
  id: string
  slug: string
  name: string
  kind: 'round_robin' | 'one_on_one'
  ownerName: string | null
  durationMinutes: number
  location: string
  isActive: boolean
  hostCount: number
  upcoming: number
  unhealthyHosts: number
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
export const PagesTable = ({ workspace, baseUrl, rows }: { workspace: string; baseUrl: string; rows: PageRow[] }) => {
  const [embedding, setEmbedding] = useState<PageRow | null>(null)

  const columns: Column<PageRow>[] = [
    {
      key: 'name',
      header: 'Meeting name',
      width: 360,
      render: (row) => (
        <span className="flex min-w-0 flex-col py-1">
          <span className="flex min-w-0 items-center gap-2">
            <Link href={bookingPagesPath(workspace, row.id)} className="truncate font-semibold" onClick={(event) => event.stopPropagation()}>
              {row.name}
            </Link>
            {row.isActive ? null : <Badge tone="neutral">Off</Badge>}
            {row.unhealthyHosts > 0 ? <Badge tone="error">{row.unhealthyHosts} without a calendar</Badge> : null}
          </span>
          <a
            href={`${baseUrl}/b/${workspace}/${row.slug}`}
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
    { key: 'organizer', header: 'Organizer', width: 180, render: (row) => row.ownerName ?? <span className="text-secondary">--</span> },
    { key: 'type', header: 'Type', width: 130, render: (row) => (row.kind === 'round_robin' ? 'Round robin' : 'One-on-one') },
    { key: 'duration', header: 'Duration', width: 110, render: (row) => `${row.durationMinutes} min` },
    { key: 'where', header: 'Location', width: 130, render: (row) => LOCATIONS[row.location] ?? row.location },
    { key: 'hosts', header: 'Hosts', width: 90, align: 'right', render: (row) => row.hostCount },
    {
      key: 'upcoming',
      header: 'Meetings booked',
      width: 150,
      align: 'right',
      render: (row) => (
        <Link href={bookedPath(workspace, { page: row.id })} onClick={(event) => event.stopPropagation()}>
          {row.upcoming.toLocaleString()}
        </Link>
      ),
    },
    {
      key: 'embed',
      header: '',
      width: 170,
      render: (row) => (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            setEmbedding(row)
          }}
          className="inline-flex h-control items-center whitespace-nowrap rounded-pill border border-line-strong px-4 text-small font-light hover:bg-fill"
        >
          Link and embed
        </button>
      ),
    },
  ]

  return (
    <>
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.id} caption="Scheduling pages in this workspace" />
      <Modal open={embedding !== null} title={embedding ? `Share “${embedding.name}”` : 'Share'} onClose={() => setEmbedding(null)}>
        {embedding ? <BookingLinkSnippet baseUrl={baseUrl} workspace={workspace} slug={embedding.slug} open /> : null}
      </Modal>
    </>
  )
}
