'use client'

import type { BookingKind } from '@rawr/db'
import { Badge, DataTable, DropdownMenu, EmptyState, NOTHING_MATCHED, Switch, type Column, useToast } from '@rawr/ui'
import { ChevronDown, ExternalLink, Search } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { EMPTY_VALUE } from '~/components/crm/value.tsx'
import { usePagedRows } from '~/components/paged.tsx'
import { RowActions, rowPill } from '~/components/row-actions.tsx'
import { availabilityPath, bookedPath, bookingPagesPath } from '~/lib/links.ts'
import { api, errorMessage } from '~/lib/rpc.ts'
import { replaceParams } from '~/lib/url-params.ts'
import { EmbedDialog, hostedBookingUrl, useCopy } from './snippet.tsx'
import { useFormat } from '~/components/zone.tsx'

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
  views: number
  booked: number
  unhealthyHosts: number
  hostsWithHours: number
}

/** HubSpot's names for the three kinds; a collective page is its Group link. */
export const KINDS: Record<BookingKind, string> = {
  one_on_one: 'One-on-one',
  collective: 'Group',
  round_robin: 'Round robin',
}

const LOCATIONS: Record<string, string> = {
  zoom: 'Zoom',
  google_meet: 'Google Meet',
  phone: 'Phone',
  custom: 'Custom',
}

/** The owner filter's value for shared pages, which have no organizer. */
const NO_OWNER = ''

const ghost =
  'inline-flex min-h-[2.4375rem] max-w-full items-center gap-1 rounded-hs px-3 font-semibold text-body transition-all duration-150 ease-out hover:bg-fill'

const isKind = (value: string | null): value is BookingKind => value !== null && value in KINDS

/** HubSpot's scheduling pages table: a search and Owner and Meeting type over
 *  it, the name with its public slug under it, Edit, Copy link and Actions on
 *  the hovered row, and each page's views, meetings booked and conversion. The
 *  search and both filters sit in the address, so a narrowed list pastes. */
export const PagesTable = ({
  account,
  baseUrl,
  rows,
  viewer,
  query,
}: {
  account: string
  baseUrl: string
  rows: PageRow[]
  /** Who is looking. The switch is only rendered where the data access layer
   *  would actually allow the change: your own page, or any page if you are an
   *  admin. A control that always throws is worse than no control. */
  viewer: { id: string; isAdmin: boolean }
  /** The address's search and filters, read on the server so the first paint is
   *  already narrowed. */
  query: { q: string; owner: string | null; type: string | null }
}) => {
  const fmt = useFormat()
  const router = useRouter()
  const toast = useToast()
  const copy = useCopy()
  const [embedding, setEmbedding] = useState<PageRow | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [needle, setNeedleState] = useState(query.q)
  const [owner, setOwnerState] = useState(query.owner)
  const [kind, setKindState] = useState(isKind(query.type) ? query.type : null)

  const setNeedle = (value: string) => {
    setNeedleState(value)
    replaceParams({ q: value.trim() === '' ? null : value })
  }
  const setOwner = (value: string | null) => {
    setOwnerState(value)
    replaceParams({ owner: value })
  }
  const setKind = (value: BookingKind | null) => {
    setKindState(value)
    replaceParams({ type: value })
  }

  const owners = [...new Set(rows.map((row) => row.ownerName ?? NO_OWNER))].sort()
  const wanted = needle.trim().toLowerCase()
  const shown = rows.filter(
    (row) =>
      (owner === null || (row.ownerName ?? NO_OWNER) === owner) &&
      (kind === null || row.kind === kind) &&
      (wanted === '' || row.name.toLowerCase().includes(wanted) || row.slug.includes(wanted)),
  )
  const filtered = wanted !== '' || owner !== null || kind !== null
  const { page, pager } = usePagedRows(shown, 'scheduling pages')

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
      width: 400,
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2 py-1">
          <span className="flex min-w-0 flex-1 flex-col items-start">
            <span className="flex max-w-full min-w-0 items-center gap-2">
              <Link href={bookingPagesPath(account, row.id)} title={row.name} className="truncate font-semibold">
                {row.name}
              </Link>
              {row.unhealthyHosts > 0 ? <Badge tone="error">{row.unhealthyHosts} without a calendar</Badge> : null}
            </span>
            <a
              href={hostedBookingUrl(baseUrl, account, row.slug)}
              target="_blank"
              rel="noreferrer"
              title={row.slug}
              className="inline-flex max-w-full items-center gap-1 text-small font-semibold"
            >
              <span className="truncate">{row.slug}</span>
              <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
            </a>
          </span>
          <RowActions>
            <Link href={bookingPagesPath(account, row.id)} className={rowPill}>
              Edit
            </Link>
            <button type="button" className={rowPill} onClick={() => void copy(hostedBookingUrl(baseUrl, account, row.slug), 'Link')}>
              Copy link
            </button>
            <DropdownMenu
              label={`Actions for ${row.name}`}
              align="start"
              groups={[
                {
                  key: 'share',
                  items: [
                    { key: 'embed', label: 'Embed', onSelect: () => setEmbedding(row) },
                    { key: 'booked', label: 'Booked meetings', href: bookedPath(account, { page: row.id }) },
                  ],
                },
              ]}
              trigger={(props) => (
                <button {...props} type="button" className={rowPill}>
                  Actions
                  <ChevronDown aria-hidden="true" className="size-3" />
                </button>
              )}
            />
          </RowActions>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 120,
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
              <Link href={availabilityPath(account)} title="No host on this page has working hours, so it offers no times.">
                <Badge tone="warn">No hours</Badge>
              </Link>
            ) : null}
          </span>
        )
      },
    },
    { key: 'organizer', header: 'Organizer', width: 160, render: (row) => row.ownerName ?? EMPTY_VALUE },
    {
      key: 'type',
      header: 'Type',
      width: 190,
      render: (row) => (
        <span className="flex min-w-0 flex-col">
          <span>{KINDS[row.kind]}</span>
          <span className="truncate text-small text-secondary">
            {LOCATIONS[row.location] ?? row.location} · {row.hostCount === 1 ? '1 host' : `${fmt.number(row.hostCount)} hosts`}
          </span>
        </span>
      ),
    },
    { key: 'duration', header: 'Duration', width: 130, render: (row) => `${row.durationMinutes} min` },
    { key: 'views', header: 'Views', width: 100, align: 'right', render: (row) => fmt.number(row.views) },
    {
      key: 'booked',
      header: 'Meetings booked',
      width: 180,
      align: 'right',
      render: (row) => (
        <span className="flex flex-col items-end">
          <Link href={bookedPath(account, { page: row.id })}>{fmt.number(row.booked)}</Link>
          {row.upcoming > 0 ? <span className="text-small text-secondary">{fmt.number(row.upcoming)} upcoming</span> : null}
        </span>
      ),
    },
    {
      key: 'conversion',
      header: 'Conversion rate',
      width: 170,
      align: 'right',
      // Nought per cent and "nobody has opened it yet" are different answers.
      render: (row) => (row.views === 0 ? EMPTY_VALUE : `${Math.round((row.booked / row.views) * 1000) / 10}%`),
    },
  ]

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <label className="relative w-full min-w-0 @lg:w-60">
          <span className="sr-only">Search meeting names</span>
          <input
            type="search"
            value={needle}
            placeholder="Search meeting names"
            onChange={(event) => setNeedle(event.target.value)}
            className="h-control w-full rounded-pill border border-line-strong bg-surface py-1 pr-9 pl-4 text-body placeholder:text-muted"
          />
          <Search aria-hidden="true" className="absolute top-1/2 right-3 size-4 -translate-y-1/2" />
        </label>
        <DropdownMenu
          label="Owner"
          align="start"
          groups={[
            {
              key: 'owner',
              items: [
                { key: 'any', label: 'Any', checked: owner === null, onSelect: () => setOwner(null) },
                ...owners.map((name) => ({
                  key: name || 'none',
                  label: name || 'No organizer',
                  checked: owner === name,
                  onSelect: () => setOwner(name),
                })),
              ],
            },
          ]}
          trigger={(props) => (
            <button {...props} type="button" className={ghost}>
              <span className="font-light">Owner:</span>
              <span className="max-w-48 truncate">{owner === null ? 'Any' : owner || 'No organizer'}</span>
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
            </button>
          )}
        />
        <DropdownMenu
          label="Meeting type"
          align="start"
          groups={[
            {
              key: 'type',
              items: [
                { key: 'any', label: 'All meeting types', checked: kind === null, onSelect: () => setKind(null) },
                ...(Object.keys(KINDS) as BookingKind[]).map((key) => ({
                  key,
                  label: KINDS[key],
                  checked: kind === key,
                  onSelect: () => setKind(key),
                })),
              ],
            },
          ]}
          trigger={(props) => (
            <button {...props} type="button" className={ghost}>
              <span className="font-light">Meeting type:</span>
              <span className="truncate">{kind === null ? 'All meeting types' : KINDS[kind]}</span>
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
            </button>
          )}
        />
        {filtered ? (
          <button
            type="button"
            className={`${ghost} text-muted`}
            onClick={() => {
              setNeedleState('')
              setOwnerState(null)
              setKindState(null)
              replaceParams({ q: null, owner: null, type: null })
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>
      <DataTable
        columns={columns}
        rows={page}
        rowKey={(row) => row.id}
        caption="Scheduling pages in this account"
        storageKey="meetings.pages"
        empty={<EmptyState {...NOTHING_MATCHED} />}
      />
      {pager}
      <EmbedDialog baseUrl={baseUrl} account={account} page={embedding} onClose={() => setEmbedding(null)} />
    </div>
  )
}
