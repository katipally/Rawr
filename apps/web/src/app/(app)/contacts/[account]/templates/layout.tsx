import type { ReactNode } from 'react'
import { HubGate } from '~/components/hub-gate.tsx'

const TemplatesLayout = ({ children }: { children: ReactNode }) => (
  <HubGate hub="sales" what="Templates">
    {children}
  </HubGate>
)

export default TemplatesLayout
