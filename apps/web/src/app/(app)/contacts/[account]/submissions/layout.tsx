import type { ReactNode } from 'react'
import { HubGate } from '~/components/hub-gate.tsx'

const SubmissionsLayout = ({ children }: { children: ReactNode }) => (
  <HubGate hub="marketing" what="Form submissions">
    {children}
  </HubGate>
)

export default SubmissionsLayout
