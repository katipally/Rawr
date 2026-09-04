import { cn } from '../cn.ts'

export type KbdProps = {
  /** The keys, in press order: `['cmd', 'k']`. Rendered with the platform's own
   *  symbols, because a Mac user reading "Ctrl" tries Ctrl and nothing happens. */
  keys: string[]
  className?: string
}

/** Mac glyphs against the words everywhere else. Resolved at render on the
 *  client and defaulting to the words on the server, so the first paint is
 *  readable on either platform rather than wrong on one. */
const MAC_GLYPH: Record<string, string> = {
  cmd: '⌘',
  meta: '⌘',
  shift: '⇧',
  alt: '⌥',
  option: '⌥',
  ctrl: '⌃',
  enter: '↵',
  esc: 'esc',
  backspace: '⌫',
}

const WORD: Record<string, string> = {
  cmd: 'Ctrl',
  meta: 'Ctrl',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  ctrl: 'Ctrl',
  enter: 'Enter',
  esc: 'Esc',
  backspace: 'Backspace',
}

const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export const Kbd = ({ keys, className }: KbdProps) => {
  const mac = isMac()
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.map((key) => {
        const lower = key.toLowerCase()
        const shown = mac ? (MAC_GLYPH[lower] ?? key.toUpperCase()) : (WORD[lower] ?? key.toUpperCase())
        return (
          <kbd
            key={key}
            className="min-w-5 rounded-hs border border-line bg-fill px-1 text-center font-sans text-small text-secondary"
          >
            {shown}
          </kbd>
        )
      })}
    </span>
  )
}
