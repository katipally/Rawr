import type { ReactNode } from 'react'
import { HubGate } from '~/components/hub-gate.tsx'

const InboxLayout = ({ children }: { children: ReactNode }) => (
  <HubGate hub="contacts" what="The inbox">
    {children}
  </HubGate>
)

export default InboxLayout
