import { Tabs } from '@rawr/ui'
import { availabilityPath, bookedPath, bookingPagesPath, calendarPath, calendarsPath } from '~/lib/links.ts'

export type MeetingsTab = 'calendar' | 'booked' | 'pages' | 'availability' | 'calendars'

/** Every screen in the Meetings hub, in the order somebody works through them:
 *  look at the month, read what is booked, hand out a link, say when you are free,
 *  fix the connection underneath. Shared, because five pages each hand-rolling
 *  their own cross-links gave five different answers to "where can I go from
 *  here" and left two of the screens unreachable from the other three. */
export const MeetingsTabs = ({ account, current }: { account: string; current: MeetingsTab }) => (
  <Tabs
    className="mb-4"
    label="Meetings"
    items={[
      { key: 'calendar', label: 'Calendar', href: calendarPath(account) },
      { key: 'booked', label: 'Booked meetings', href: bookedPath(account) },
      { key: 'pages', label: 'Meeting links', href: bookingPagesPath(account) },
      { key: 'availability', label: 'My hours', href: availabilityPath(account) },
      { key: 'calendars', label: 'Calendar connections', href: calendarsPath(account) },
    ].map((item) => ({ ...item, current: item.key === current }))}
  />
)
