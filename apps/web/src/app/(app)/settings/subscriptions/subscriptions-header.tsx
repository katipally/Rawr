import { PageHeader, Tabs } from '@rawr/ui'
import type { ReactNode } from 'react'
import { consentRecordsPath, subscriptionsPath } from '~/lib/links.ts'

/** HubSpot keeps subscription types and the consent behind them as tabs of one
 *  page; each tab is its own address here. */
export const SubscriptionsHeader = ({ current, why }: { current: 'types' | 'consent'; why: ReactNode }) => (
  <div className="flex flex-col gap-3">
    <PageHeader title="Subscriptions" why={why} />
    <Tabs
      label="Subscriptions"
      items={[
        { key: 'types', label: 'Subscription Types', href: subscriptionsPath(), current: current === 'types' },
        { key: 'consent', label: 'Consent Records', href: consentRecordsPath(), current: current === 'consent' },
      ]}
    />
  </div>
)
