import { cn } from '@rawr/ui'

/** HubSpot's own bands, measured in its portal: red up to 49, amber through 69,
 *  green from 70, and a grey dash for a deal nothing has been computed for yet.
 *
 *  The same three thresholds as `scoreBand` in the DAL, restated rather than
 *  imported: this renders on a board card, and importing a value from '@rawr/db'
 *  here pulls the Postgres driver into the client bundle. */
const toneFor = (score: number | null): string =>
  score === null ? 'text-secondary' : score >= 70 ? 'text-success' : score >= 50 ? 'text-warning' : 'text-error'

/** A circle of circumference 100, so the dash array is the score itself and no
 *  arithmetic stands between the number and the arc. */
const RADIUS = 100 / (2 * Math.PI)

export type ScoreRingProps = {
  score: number | null
  /** Sized in em, so the ring follows whatever text it sits beside: a board card,
   *  a table cell and a record card all set their own size and none of them has
   *  to say how many pixels that is. */
  className?: string
}

export const ScoreRing = ({ score, className }: ScoreRingProps) => {
  const filled = Math.max(0, Math.min(100, score ?? 0))
  return (
    <svg
      viewBox="0 0 36 36"
      role="img"
      aria-label={score === null ? 'Deal score not computed yet' : `Deal score ${score} out of 100`}
      className={cn('size-[2.5em] shrink-0', toneFor(score), className)}
    >
      <circle cx="18" cy="18" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="3" opacity="0.2" />
      {score === null ? null : (
        <circle
          cx="18"
          cy="18"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${filled} 100`}
          transform="rotate(-90 18 18)"
        />
      )}
      <text
        x="18"
        y="18"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        fontSize="14"
        fontWeight="600"
      >
        {score === null ? '–' : score}
      </text>
    </svg>
  )
}
