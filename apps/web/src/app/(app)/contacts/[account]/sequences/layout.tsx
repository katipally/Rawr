import type { ReactNode } from 'react'
import { HubGate } from '~/components/hub-gate.tsx'

const SequencesLayout = ({ children }: { children: ReactNode }) => (
  <HubGate hub="sales" what="Sequences">
    {children}
  </HubGate>
)

export default SequencesLayout
