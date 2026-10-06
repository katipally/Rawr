'use client'

import { Avatar, Badge, DataTable, DropdownMenu, type Column } from '@rawr/ui'
import { ChevronDown, Search } from 'lucide-react'
import Link from 'next/link'
import { useState } from 'react'
import type { HealthState, IntegrationKind } from '@rawr/db'
import { AppLogo } from '~/components/app-logo.tsx'
import { appPath } from '~/lib/links.ts'
import { AppActions } from './app-actions.tsx'
import { HEALTH, errorSummary } from './health.ts'
import { useFormat } from '~/components/zone.tsx'

export type AppRow = {
  kind: IntegrationKind
  name: string
  category: string
  personal: boolean
  connectPath: string
  state: HealthState
  lastError: string | null
  installedAt: string | null
  installedByName: string | null
  installedByEmail: string | null
  lastActivityAt: string | null
  people: number
}

const STATUS: { value: string; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'connected', label: 'Connected' },
  { value: 'degraded', label: 'Needs attention' },
  { value: 'disconnected', label: 'Disconnected' },
]

/** HubSpot's ghost filter button: no border, 39 tall, grey on hover. */
const ghost =
  'inline-flex min-h-[2.4375rem] items-center gap-1 rounded-hs px-3 font-semibold text-body transition-all duration-150 ease-out hover:bg-fill'

const Muted = ({ children }: { children: string }) => <span className="text-secondary">{children}</span>

/** Every app this account has connected, with the facts HubSpot's own table
 *  leads on: what it is, whether it is working, who installed it and when, when
 *  it last did anything, and an Actions menu on the row. */
export const AppsTable = ({ rows, canManage }: { rows: AppRow[]; canManage: boolean }) => {
  const fmt = useFormat()
  const [query, setQuery] = useState('')
  const [state, setState] = useState('')

  const needle = query.trim().toLowerCase()
  const visible = rows.filter(
    (row) =>
      (state === '' || row.state === state) &&
      (needle === '' || row.name.toLowerCase().includes(needle) || row.category.toLowerCase().includes(needle)),
  )

  const columns: Column<AppRow>[] = [
    {
      key: 'app',
      header: 'App',
      width: 260,
      render: (row) => (
        <Link href={appPath(row.kind)} className="flex items-center gap-3 font-medium text-link no-underline hover:underline">
          <AppLogo kind={row.kind} />
          <span className="min-w-0 truncate">{row.name}</span>
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 160,
      render: (row) => (
        <span title={row.lastError ? errorSummary(row.lastError).headline : undefined}>
          {/*  The label wraps rather than truncating: "Needs attention" read as
               "Needs atten..." in a narrowed column. */}
          <Badge tone={HEALTH[row.state].tone} dot className="[&>span]:whitespace-normal">
            {HEALTH[row.state].label}
          </Badge>
        </span>
      ),
    },
    {
      key: 'installed',
      header: 'Installed date',
      width: 190,
      render: (row) => (row.installedAt ? fmt.dateTime(row.installedAt) : <Muted>--</Muted>),
    },
    {
      key: 'by',
      header: 'Installed by',
      width: 230,
      render: (row) =>
        row.personal ? (
          // Granted person by person, so no single installer: the count is the
          // honest answer and the link is where the names are.
          <Link href={row.connectPath} className="text-link no-underline hover:underline">
            {row.people === 1 ? '1 person' : `${fmt.number(row.people)} people`}
          </Link>
        ) : row.installedByName ? (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={row.installedByName} size="md" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{row.installedByName}</span>
              {row.installedByEmail ? <span className="truncate text-small text-secondary">{row.installedByEmail}</span> : null}
            </span>
          </span>
        ) : (
          <Muted>Not by a person</Muted>
        ),
    },
    {
      key: 'activity',
      header: 'Last activity',
      width: 190,
      render: (row) => (row.lastActivityAt ? fmt.dateTime(row.lastActivityAt) : <Muted>Never</Muted>),
    },
    {
      key: 'actions',
      header: '',
      width: 120,
      align: 'right',
      render: (row) => (
        <AppActions kind={row.kind} name={row.name} personal={row.personal} connectPath={row.connectPath} canManage={canManage} />
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <label className="relative w-full min-w-0 sm:w-[25rem]">
          <span className="sr-only">Search for an app</span>
          <input
            type="search"
            value={query}
            placeholder="Search for an app"
            onChange={(event) => setQuery(event.target.value)}
            className="h-10 w-full rounded-pill border border-line-strong bg-surface py-2 pr-10 pl-4 text-body placeholder:text-muted"
          />
          <Search aria-hidden="true" className="absolute top-1/2 right-4 size-4 -translate-y-1/2" />
        </label>
        <DropdownMenu
          label="App status"
          align="start"
          groups={[
            {
              key: 'status',
              items: STATUS.map((option) => ({
                key: option.value || 'any',
                label: option.label,
                checked: state === option.value,
                onSelect: () => setState(option.value),
              })),
            },
          ]}
          trigger={(props) => (
            <button {...props} type="button" className={ghost}>
              {state ? `App status: ${STATUS.find((option) => option.value === state)?.label}` : 'App status'}
              <ChevronDown aria-hidden="true" className="size-3.5" />
            </button>
          )}
        />
      </div>

      <DataTable
        columns={columns}
        rows={visible}
        rowKey={(row) => row.kind}
        caption="Apps connected to this account"
        empty="Nothing matches."
        storageKey="rawr.apps.columns"
      />
    </div>
  )
}
