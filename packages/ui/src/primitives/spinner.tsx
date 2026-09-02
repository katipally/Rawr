import { cn } from '../cn.ts'

export type SpinnerProps = {
  /** What is being waited for, read by screen readers. */
  label?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZES = { sm: 'size-4 border-2', md: 'size-6 border-2', lg: 'size-8 border-[3px]' }

/** One spinner for every wait. A ring rather than dots or bars so it reads the
 *  same at 16px in a button and 32px in the middle of a screen. */
export const Spinner = ({ label = 'Loading', size = 'md', className }: SpinnerProps) => (
  <span role="status" aria-live="polite" className={cn('inline-flex items-center justify-center', className)}>
    <span
      aria-hidden="true"
      className={cn(
        'block animate-spin rounded-full border-current border-r-transparent motion-reduce:animate-none',
        SIZES[size],
      )}
    />
    <span className="sr-only">{label}</span>
  </span>
)

/** A screen-sized wait: centred, with room around it, for route loading states. */
export const LoadingScreen = ({ label = 'Loading' }: { label?: string }) => (
  <div className="flex min-h-[40vh] flex-1 items-center justify-center text-secondary">
    <Spinner size="lg" label={label} />
  </div>
)
