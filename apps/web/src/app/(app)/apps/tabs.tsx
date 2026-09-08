import { Tabs } from '@rawr/ui'
import { appsPath, availableAppsPath } from '~/lib/links.ts'

/** The two halves HubSpot splits its Connected Apps into, minus the marketplace:
 *  what is installed, and what could be. Shared by both screens so the count and
 *  the wording cannot drift between them. */
export const AppsTabs = ({
  current,
  connectedCount,
}: {
  current: 'home' | 'available'
  connectedCount: number
}) => (
  <Tabs
    label="Connected apps"
    items={[
      {
        key: 'home',
        label: 'Connections home',
        hint: String(connectedCount),
        href: appsPath(),
        current: current === 'home',
      },
      {
        key: 'available',
        label: 'Available apps',
        href: availableAppsPath(),
        current: current === 'available',
      },
    ]}
  />
)
