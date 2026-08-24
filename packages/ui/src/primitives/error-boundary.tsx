'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './button.tsx'

type Props = { children: ReactNode; label: string }
type State = { message: string | null }

/** Never renders "something went wrong". The real message is shown, because the
 *  person reading it is a colleague who can act on it. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Record values are never logged, only ids and the message itself.
    console.error(`[${this.props.label}]`, error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-3 rounded-panel border border-error bg-error-subtle p-4"
      >
        <p className="font-medium">{this.props.label} could not be shown.</p>
        <p className="break-words text-secondary">{this.state.message}</p>
        <Button onClick={() => this.setState({ message: null })}>Try again</Button>
      </div>
    )
  }
}
