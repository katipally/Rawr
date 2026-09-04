import type { StageChange, WorkspaceContext } from '@rawr/db'
import { inBackground } from './background.ts'
import { queueStageAlert } from './notify.ts'
import { shouldAnnounceStage, slackCredentials } from './integrations/slack.ts'

/** F6 §5. Deal stage-change alerts, opt-in per pipeline.
 *
 *  Opt-in because a channel that announces every move on every deal is a channel
 *  people mute, and a muted channel is how the form-fill notification stops being
 *  read. Which pipelines announce is configured on the Slack integration.
 *
 *  Not awaited: the person who dragged the card is looking at the board, not at
 *  Slack, and a Slack outage must never fail a stage change. It still has to
 *  happen, though, so it runs after the response rather than in a promise nobody
 *  is holding. */
export const announceStageChange = (
  ctx: WorkspaceContext,
  workspaceSlug: string,
  change: StageChange | undefined,
  actorName = 'Somebody',
): void => {
  if (!change) return

  inBackground(`stage alert for deal ${change.dealId}`, async () => {
    // Reading the credentials can fail, which is already visible as a degraded
    // integration. A stage change is not the place to surface it, so this returns
    // rather than announcing against credentials it could not read.
    const credentials = await slackCredentials(ctx).catch(() => null)
    if (!shouldAnnounceStage(credentials, change.pipelineId)) return
    queueStageAlert({
      workspaceId: ctx.workspaceId,
      workspaceSlug,
      dealId: change.dealId,
      dealName: change.dealName,
      from: change.from,
      to: change.to,
      actor: actorName,
      activityId: change.activityId,
    })
  })
}
