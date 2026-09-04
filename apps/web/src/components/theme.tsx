'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useServerInsertedHTML } from 'next/navigation'

export type Theme = 'light' | 'dark' | 'system'
const KEY = 'rawr-theme'
export const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'Match system', icon: Monitor },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
]

/** Runs before paint so a dark-mode user never sees a white flash. It resolves
 *  `system` here rather than in a media query, because the tokens carry one dark
 *  block keyed on the attribute: nothing renders dark until this has run.
 *  Reading localStorage throws in some embedded contexts, hence the try. */
const themeScript = `try{var t=localStorage.getItem('${KEY}');if(t!=='dark'&&t!=='light')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t}catch(e){}`

/** Injected into the streamed HTML rather than rendered as a `<script>` element.
 *  A script React renders is inert on the client and React 19 warns about it,
 *  and this one only has to run once, before the first paint. */
export const ThemeScript = () => {
  useServerInsertedHTML(() => <script dangerouslySetInnerHTML={{ __html: themeScript }} />)
  return null
}

const stored = (): Theme => {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'dark' || value === 'light' ? value : 'system'
  } catch {
    return 'system'
  }
}

const paint = (theme: Theme) => {
  const resolved =
    theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
  document.documentElement.dataset.theme = resolved
}

export const applyTheme = (theme: Theme) => {
  paint(theme)
  try {
    if (theme === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {
    // A browser blocking site data still gets a working toggle for this page view.
  }
}

/** The stored preference, and a setter that repaints. `system` keeps following
 *  the OS for as long as it is the choice, which the pre-paint script cannot do
 *  on its own because it runs once. */
export const useTheme = (): [Theme, (next: Theme) => void] => {
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => setTheme(stored()), [])

  useEffect(() => {
    if (theme !== 'system') return
    const media = matchMedia('(prefers-color-scheme: dark)')
    const follow = () => paint('system')
    media.addEventListener('change', follow)
    return () => media.removeEventListener('change', follow)
  }, [theme])

  return [
    theme,
    (next: Theme) => {
      setTheme(next)
      applyTheme(next)
    },
  ]
}
