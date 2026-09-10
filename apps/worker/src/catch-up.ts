/** Boot-time catch-up for the jobs that run once a day.
 *
 *  The container sleeps on the free tier, and a schedule pg-boss never got to
 *  evaluate is a night with no roll-up and no overdue-task notices. So on boot
 *  each daily job is asked one question: has it completed since the last time it
 *  was supposed to run. If not, it is queued once, keyed by that day, so two
 *  restarts in one morning still produce one run.
 *
 *  Pure on purpose. The hour a job is due, whether it is overdue, and the key
 *  that makes it once-a-day are all easy to get quietly wrong, and none of them
 *  needs a database or the real clock to check. */

export type DailyAt = { hourUtc: number; minuteUtc: number }

export const cronFor = (at: DailyAt): string => `${at.minuteUtc} ${at.hourUtc} * * *`

/** The most recent instant that cron fired, at or before `now`. */
export const lastOccurrence = (now: Date, at: DailyAt): Date => {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    at.hourUtc,
    at.minuteUtc,
  )
  return new Date(today <= now.getTime() ? today : today - 86_400_000)
}

export const dayKeyUtc = (at: Date): string => at.toISOString().slice(0, 10)

export const isOverdue = (lastCompletedAt: Date | null, occurrence: Date): boolean =>
  lastCompletedAt === null || lastCompletedAt.getTime() < occurrence.getTime()
