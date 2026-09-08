import { buttonClass, cn } from '@rawr/ui'
import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'tertiary' | 'destructive'

/** Navigation drawn as a button: an anchor, so it opens in a new tab, copies its
 *  address and survives a middle click, cut from the same shape as `Button` so a
 *  row of "Disconnect" and "Working hours" reads as one row of controls rather
 *  than a control and a stray sentence. */
export const LinkButton = ({
  variant = 'secondary',
  icon,
  className,
  children,
  ...rest
}: ComponentProps<typeof Link> & { variant?: Variant; icon?: ReactNode }) => (
  <Link {...rest} className={buttonClass(variant, cn(variant === 'tertiary' ? 'no-underline hover:underline' : 'no-underline', className))}>
    {icon}
    <span className="min-w-0 break-words">{children}</span>
  </Link>
)
