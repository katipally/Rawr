import { PageHeader, Tabs } from '@rawr/ui'
import type { ReactNode } from 'react'
import { membersPath, teamsPath } from '~/lib/links.ts'

/** HubSpot's one Users & Teams page: the title over a Users | Teams row of
 *  folder tabs, each tab its own address here. */
export const UsersTeamsHeader = ({ current, why }: { current: 'users' | 'teams'; why?: ReactNode }) => (
  <div className="flex flex-col gap-3">
    <PageHeader title="Users & Teams" why={why} />
    <Tabs
      label="Users and teams"
      items={[
        { key: 'users', label: 'Users', href: membersPath(), current: current === 'users' },
        { key: 'teams', label: 'Teams', href: teamsPath(), current: current === 'teams' },
      ]}
    />
  </div>
)
