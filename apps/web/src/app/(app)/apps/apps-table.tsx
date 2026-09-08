'use client'

import { Avatar, Badge, DataTable, Field, Select, TextInput, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useState } from 'react'
import type { HealthState, IntegrationKind } from '@rawr/db'
import { AppLogo } from '~/components/app-logo.tsx'
import { formatDateTime } from '~/components/crm/value.tsx'
import { appPath } from '~/lib/links.ts'
import { AppActions } from './app-actions.tsx'
import { HEALTH } from './health.ts'

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

const Muted = ({ children }: { children: string }) => <span className="text-secondary">{children}</span>

/** Every app this account has connected, with the facts HubSpot's own table
 *  leads on: what it is, whether it is working, who installed it and when, when
 *  it last did anything, and an Actions menu on the row. */
export const AppsTable = ({ rows, canManage }: { rows: AppRow[]; canManage: boolean }) => {
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
        <span title={row.lastError ?? undefined}>
          <Badge tone={HEALTH[row.state].tone} dot>
            {HEALTH[row.state].label}
          </Badge>
        </span>
      ),
    },
    {
      key: 'installed',
      header: 'Installed date',
      width: 190,
      render: (row) => (row.installedAt ? formatDateTime(row.installedAt) : <Muted>--</Muted>),
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
            {row.people === 1 ? '1 person' : `${row.people.toLocaleString()} people`}
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
      render: (row) => (row.lastActivityAt ? formatDateTime(row.lastActivityAt) : <Muted>Never</Muted>),
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
      <div className="flex flex-wrap items-end gap-3">
        <Field id="app-search" label="Search for an app">
          <TextInput id="app-search" value={query} placeholder="Name or category" onChange={(event) => setQuery(event.target.value)} />
        </Field>
        <Field id="app-status" label="App status">
          <Select id="app-status" value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">Any status</option>
            <option value="connected">Connected</option>
            <option value="degraded">Needs attention</option>
            <option value="disconnected">Disconnected</option>
          </Select>
        </Field>
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
