import type { ReactNode } from 'react'
import { HubGate } from '~/components/hub-gate.tsx'

const TasksLayout = ({ children }: { children: ReactNode }) => (
  <HubGate hub="contacts" what="Tasks">
    {children}
  </HubGate>
)

export default TasksLayout
