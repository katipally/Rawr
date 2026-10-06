'use client'

import { IconButton, useToast } from '@rawr/ui'
import { Copy } from 'lucide-react'

/** HubSpot's small copy icon beside an email, a domain or a phone number. */
export const CopyButton = ({ value, what }: { value: string; what: string }) => {
  const toast = useToast()
  return (
    <IconButton
      label={`Copy ${what.toLowerCase()}`}
      icon={<Copy aria-hidden="true" className="size-3.5" />}
      className="size-6"
      onClick={() =>
        navigator.clipboard.writeText(value).then(
          () => toast('success', `${what} copied.`),
          () => toast('error', 'Your browser would not let this page use the clipboard. Select it and copy by hand.'),
        )
      }
    />
  )
}
