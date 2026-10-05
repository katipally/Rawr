/** Runs `tick` every `ms`, but only while this tab is on screen, and once as soon
 *  as it comes back. A tab left in the background asks for nothing, which matters
 *  because every ask is a database transaction on a small pool. Client only.
 *  Returns the function that stops it. */
export const pollWhileVisible = (tick: () => void, ms: number): (() => void) => {
  const run = () => {
    if (!document.hidden) tick()
  }
  const timer = window.setInterval(run, ms)
  document.addEventListener('visibilitychange', run)
  return () => {
    window.clearInterval(timer)
    document.removeEventListener('visibilitychange', run)
  }
}
