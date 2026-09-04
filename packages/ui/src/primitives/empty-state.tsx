import type { ReactNode } from 'react'

export type EmptyStateProps = {
  title: string
  /** What to do next, when there is something to do. Optional: a table with no
   *  rows because the filter matched nothing needs a title and a clear button,
   *  not a paragraph, and making this required meant seventeen screens each grew
   *  a sentence whether they had one worth writing or not. */
  description?: string
  action?: ReactNode
  icon?: ReactNode
}

export const EmptyState = ({ title, description, action, icon }: EmptyStateProps) => (
  <div className="flex flex-col items-center gap-2 px-4 py-6 text-center @md:px-6 @md:py-12">
    {icon ? <div className="text-secondary">{icon}</div> : null}
    <p className="font-medium">{title}</p>
    {description ? <p className="max-w-prose text-secondary">{description}</p> : null}
    {action ? <div className="mt-2">{action}</div> : null}
  </div>
)
