import type { IntegrationKind } from '@rawr/db'
import { cn } from '@rawr/ui'

/** The provider's own mark, served as a file so the coloured ones keep their
 *  colours and none of them is redrawn as a glyph that only resembles it. Every
 *  kind has a file; a missing one is a build mistake, not a runtime state. */
export const AppLogo = ({ kind, className }: { kind: IntegrationKind; className?: string }) => (
  <img
    src={`/app-logos/${kind}.svg`}
    alt=""
    aria-hidden="true"
    width={24}
    height={24}
    className={cn('size-6 shrink-0 object-contain', className)}
  />
)
