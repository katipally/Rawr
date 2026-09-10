'use client'

import { Tabs } from '@rawr/ui'
import { usePathname } from 'next/navigation'
import { trackingPath } from '~/lib/links.ts'

/** Three things measured through the same pixel: where its links point, what the
 *  sites fire, and what the campaigns behind the traffic cost. */
const ITEMS = [
  { key: 'domain', label: 'Domain', href: trackingPath() },
  { key: 'events', label: 'Events', href: trackingPath('events') },
  { key: 'campaigns', label: 'Campaigns', href: trackingPath('campaigns') },
]

export const TrackingTabs = () => {
  const pathname = usePathname()
  return (
    <Tabs
      label="Tracking"
      items={ITEMS.map((item) => ({
        key: item.key,
        label: item.label,
        href: item.href,
        current: item.key === 'domain' ? pathname === item.href : pathname.startsWith(item.href),
      }))}
    />
  )
}
