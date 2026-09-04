import { cn } from '../cn.ts'

const SIZES = { sm: 'size-6 text-small', md: 'size-8', lg: 'size-10' } as const

/** Deterministic tint from the name, so the same person is the same colour on
 *  every screen without storing one. Six hues, all carrying body text at 4.5:1. */
const TINTS = [
  'bg-accent-subtle text-accent',
  'bg-success-subtle text-success',
  'bg-warning-subtle text-warning',
  'bg-error-subtle text-error',
  'bg-info-subtle text-info',
  'bg-cta-subtle text-cta',
]

const initialsOf = (name: string): string => {
  const words = name.trim().split(/[\s@._-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]?.[0] ?? ''
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : ''
  return (first + second).toUpperCase()
}

const tintOf = (name: string): string => {
  let sum = 0
  for (const character of name) sum = (sum + character.codePointAt(0)!) % 4093
  return TINTS[sum % TINTS.length]!
}

export type AvatarProps = {
  name: string
  size?: keyof typeof SIZES
  className?: string
}

/** Initials on a tint. No image: nobody uploads one here, and a broken remote
 *  photo is worse than a letter. */
export const Avatar = ({ name, size = 'md', className }: AvatarProps) => (
  <span
    aria-hidden="true"
    title={name}
    className={cn(
      'inline-flex shrink-0 items-center justify-center rounded-full font-medium',
      SIZES[size],
      tintOf(name),
      className,
    )}
  >
    {initialsOf(name)}
  </span>
)
