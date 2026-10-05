import type { ReactNode } from 'react'
import { readSession } from '~/server/session.ts'
import { accountHome } from '~/lib/links.ts'
import { settingsGroups } from '~/lib/settings-nav.ts'
import { SettingsNav } from './nav.tsx'

const SettingsLayout = async ({ children }: { children: ReactNode }) => {
  const session = await readSession()
  return (
  // One column on a phone, scrolling as one page, with the rail capped so the
  // first screen is not only a menu. Once there is room for a rail
  // beside the content, the two scroll independently: the rail stays put while a
  // long settings page moves, which is the whole reason to have a rail.
  <div className="grid min-h-full bg-surface lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:overflow-hidden">
    <div className="z-10 max-h-[40dvh] overflow-y-auto bg-surface shadow-panel lg:max-h-none lg:min-h-0 lg:overscroll-contain">
      <SettingsNav
        groups={settingsGroups()}
        backHref={session ? accountHome(session.accountSlug) : '/'}
      />
    </div>
    <div className="min-w-0 p-6 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
      {children}
    </div>
  </div>
  )
}

export default SettingsLayout
