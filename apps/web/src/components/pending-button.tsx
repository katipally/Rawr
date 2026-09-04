'use client'

import { useFormStatus } from 'react-dom'

/** A submit button that says it is working.

 *  The public form and booking pages post to Server Actions, which means a real
 *  round trip with a calendar read and a write in the middle of it. Without this,
 *  the only feedback is the browser's own spinner in a tab somebody is not looking
 *  at, so they press it again.
 *
 *  useFormStatus rather than local state, because the pending flag has to come from
 *  the form this button belongs to. It reads as false until the form is actually
 *  submitting, which is also what makes this correct when no script has loaded: the
 *  button renders as a plain submit and the page still works. */
export const PendingButton = ({
  children,
  pendingLabel,
  className,
}: {
  children: React.ReactNode
  pendingLabel: string
  className?: string
}) => {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      className={className}
      disabled={pending}
      aria-busy={pending}
      // The width is the widest of the two labels either way, so the button does
      // not shrink under the cursor when the words change.
      style={{ minInlineSize: 'max-content' }}
    >
      {pending ? pendingLabel : children}
    </button>
  )
}
