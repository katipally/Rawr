import type { ReactNode } from 'react'
import { HubGate } from '~/components/hub-gate.tsx'

const FormsLayout = ({ children }: { children: ReactNode }) => (
  <HubGate hub="marketing" what="Forms">
    {children}
  </HubGate>
)

export default FormsLayout
