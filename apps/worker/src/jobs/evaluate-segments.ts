import { evaluateAllSegments, type WorkspaceContext } from '@rawr/db'
import { z } from 'zod'
import { owner } from '../db.ts'
import { defineJob } from './registry.ts'

/** A2: "membership recomputed on write and on a schedule". This is the schedule.
 *
 *  A segment answers a question about records that change constantly, so its
 *  membership is always a little behind. The scheduled pass is what bounds how far:
 *  a contact who became a customer this morning is in the customer segment, and on
 *  their timeline, within the hour rather than whenever somebody happens to press a
 *  button.
 *
 *  A segment whose filter refers to a field that has since been deleted fails on
 *  its own and does not take the others with it, which is why the layer reports per
 *  segment rather than throwing. Those failures are dead-lettered by name so an
 *  admin can see which query broke. */
const jobContext = (workspaceId: string): WorkspaceContext => ({
  workspaceId,
  actorId: null,
  actorKind: 'job',
  role: 'marketing',
})

export const evaluateSegments = defineJob({
  name: 'segments.evaluate',
  schema: z.object({}),
  retryLimit: 3,
  retryDelaySeconds: 300,
  handle: async () => {
    // Per workspace, so one tenant's slow query cannot stall another's. The only
    // query here that crosses tenants, and it reads nothing but ids.
    const workspaces = await owner`select id from workspace`
    const broken: string[] = []

    for (const row of workspaces) {
      const results = await evaluateAllSegments(jobContext(row.id))
      for (const result of results) {
        if (result.error !== null) {
          broken.push(`${result.name}: ${result.error}`)
          continue
        }
        if (result.result && (result.result.entered > 0 || result.result.exited > 0)) {
          console.log(
            `[segments] ${result.name}: ${result.result.entered} in, ${result.result.exited} out, ${result.result.members} now.`,
          )
        }
      }
    }

    // Thrown rather than logged: a broken segment is somebody's list silently
    // going stale, and the retry-then-dead-letter path is what puts it on a screen.
    if (broken.length > 0) {
      throw new Error(`${broken.length} segment(s) could not be evaluated. ${broken.join(' | ')}`)
    }
  },
})
