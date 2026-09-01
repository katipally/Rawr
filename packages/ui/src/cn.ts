import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/** tailwind-merge has to be told about the design system's own type scale.
 *
 *  `text-body` and `text-small` are font sizes, but tailwind-merge only knows the
 *  built-in scale, so it files any other `text-*` under colour. Without this,
 *  `cn('text-small', 'text-secondary')` resolves to `text-secondary` alone and
 *  every 12px label in the app silently renders at 14px. The token names live in
 *  tokens.css; this is the one place that repeats them. */
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['body', 'small'] }],
      'font-weight': [{ font: ['body', 'label', 'link'] }],
    },
  },
})

export const cn = (...inputs: ClassValue[]): string => merge(clsx(inputs))
