import type { ReactNode } from 'react'

export type EmptyStateProps = {
  title: string
  /** Says what to do next, never just "no data". */
  description: string
  action?: ReactNode
  icon?: ReactNode
}

export const EmptyState = ({ title, description, action, icon }: EmptyStateProps) => (
  <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
    {icon ? <div className="text-secondary">{icon}</div> : null}
    <p className="font-medium">{title}</p>
    <p className="max-w-prose text-secondary">{description}</p>
    {action ? <div className="mt-2">{action}</div> : null}
  </div>
)
