'use client'

import { Avatar, Badge, DataTable, Field, Select, TextInput, type Column } from '@rawr/ui'
import Link from 'next/link'
import { useState } from 'react'
import type { HealthState, IntegrationKind } from '@rawr/db'
import { formatDateTime } from '~/components/crm/value.tsx'
import { INTEGRATION_ICONS } from '~/components/icons.ts'
import { appPath } from '~/lib/links.ts'

export type AppRow = {
  kind: IntegrationKind
  name: string
  category: string
  state: HealthState
  lastError: string | null
  installedAt: string | null
  installedByName: string | null
  lastActivityAt: string | null
}

const HEALTH: Record<HealthState, { label: string; tone: 'ok' | 'warn' | 'error' | 'neutral' }> = {
  connected: { label: 'Connected', tone: 'ok' },
  degraded: { label: 'Needs attention', tone: 'warn' },
  disconnected: { label: 'Disconnected', tone: 'error' },
  not_configured: { label: 'Not configured', tone: 'neutral' },
}

/** Every app this organisation has connected, with the four facts HubSpot's own
 *  table leads on: what it is, whether it is working, who installed it and when,
 *  and when it last did anything. */
export const AppsTable = ({ rows }: { rows: AppRow[] }) => {
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
      render: (row) => {
        const Icon = INTEGRATION_ICONS[row.kind]
        return (
          <Link href={appPath(row.kind)} className="flex items-center gap-2 font-medium text-link no-underline hover:underline">
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{row.name}</span>
          </Link>
        )
      },
    },
    { key: 'category', header: 'Category', width: 140, render: (row) => row.category },
    {
      key: 'status',
      header: 'Status',
      width: 170,
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
      render: (row) => (row.installedAt ? formatDateTime(row.installedAt) : <span className="text-secondary">--</span>),
    },
    {
      key: 'by',
      header: 'Installed by',
      width: 190,
      render: (row) =>
        row.installedByName ? (
          <span className="flex min-w-0 items-center gap-2">
            <Avatar name={row.installedByName} size="sm" />
            <span className="min-w-0 truncate">{row.installedByName}</span>
          </span>
        ) : (
          // Not "unknown": a job or a migration connected it, and saying so is
          // more use than a blank that reads as missing data.
          <span className="text-secondary">Not by a person</span>
        ),
    },
    {
      key: 'activity',
      header: 'Last activity',
      width: 190,
      render: (row) =>
        row.lastActivityAt ? formatDateTime(row.lastActivityAt) : <span className="text-secondary">Never</span>,
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field id="app-search" label="Find">
          <TextInput
            id="app-search"
            value={query}
            placeholder="Name or category"
            onChange={(event) => setQuery(event.target.value)}
          />
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
        caption="Apps connected to this organisation"
        empty="Nothing matches."
        storageKey="rawr.apps.columns"
      />
    </div>
  )
}
