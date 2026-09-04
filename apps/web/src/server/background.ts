import { after } from 'next/server'

/** Work the caller must never wait for, and that must still finish.
 *
 *  The two halves matter separately. A visitor confirming a booking is not
 *  waiting on Zoom, and a person dragging a card is not waiting on Slack, so
 *  neither call is awaited. But a bare `void promise` only survives by accident:
 *  once the response is written the runtime is free to reclaim the invocation,
 *  and a Slack post or a 75-second Zoom retry that was still in flight is simply
 *  gone, with nothing recorded to say a lead was never announced.
 *
 *  `after` is the guarantee. Next runs the callback once the response is sent and
 *  keeps the invocation alive until it settles, so the work is off the critical
 *  path and still finishes.
 *
 *  Outside a request there is no scope to register against. That is a script or a
 *  test rather than a served request, nothing is about to reclaim the process, and
 *  running the work inline is the honest fallback. */
export const inBackground = (label: string, work: () => Promise<unknown>): void => {
  const run = async (): Promise<void> => {
    try {
      await work()
    } catch (cause) {
      // Every caller here already records its own failures where a person can see
      // them. This is the last resort, so that nothing is swallowed in silence and
      // an unhandled rejection cannot take the process down.
      console.error(`[background] ${label} failed:`, cause)
    }
  }

  try {
    after(run)
  } catch {
    void run()
  }
}
