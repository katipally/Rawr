import type { ReactNode } from 'react'
import { HubGate } from '~/components/hub-gate.tsx'

const SegmentsLayout = ({ children }: { children: ReactNode }) => (
  <HubGate hub="contacts" what="Segments">
    {children}
  </HubGate>
)

export default SegmentsLayout
