'use client'

import { useServerInsertedHTML } from 'next/navigation'
import { useEffect, useState } from 'react'

type Theme = 'light' | 'dark' | 'system'
const KEY = 'rawr-theme'

/** Runs before paint so a dark-mode user never sees a white flash. Reading
 *  localStorage throws in some embedded contexts, hence the try. */
const themeScript = `try{var t=localStorage.getItem('${KEY}');if(t==='dark'||t==='light')document.documentElement.dataset.theme=t}catch(e){}`

/** Injected into the streamed HTML rather than rendered as a `<script>` element.
 *  A script React renders is inert on the client and React 19 warns about it,
 *  and this one only has to run once, before the first paint. */
export const ThemeScript = () => {
  useServerInsertedHTML(() => <script dangerouslySetInnerHTML={{ __html: themeScript }} />)
  return null
}

const apply = (theme: Theme) => {
  const root = document.documentElement
  if (theme === 'system') delete root.dataset.theme
  else root.dataset.theme = theme
  try {
    if (theme === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, theme)
  } catch {
    // A browser blocking site data still gets a working toggle for this page view.
  }
}

export const ThemeToggle = () => {
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    try {
      const stored = localStorage.getItem(KEY)
      if (stored === 'dark' || stored === 'light') setTheme(stored)
    } catch {
      // Nothing stored is readable; system it is.
    }
  }, [])

  return (
    <label className="flex items-center gap-2">
      <span className="sr-only">Theme</span>
      <select
        value={theme}
        onChange={(event) => {
          const next = event.target.value as Theme
          setTheme(next)
          apply(next)
        }}
        className="min-h-8 rounded-hs border border-line bg-surface pl-2 pr-7 text-small"
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  )
}
