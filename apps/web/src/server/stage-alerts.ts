import type { StageChange, WorkspaceContext } from '@rawr/db'
import { queueStageAlert } from './notify.ts'
import { shouldAnnounceStage, slackCredentials } from './integrations/slack.ts'

/** F6 §5. Deal stage-change alerts, opt-in per pipeline.
 *
 *  Opt-in because a channel that announces every move on every deal is a channel
 *  people mute, and a muted channel is how the form-fill notification stops being
 *  read. Which pipelines announce is configured on the Slack integration.
 *
 *  Fired and not awaited: the person who dragged the card is looking at the board,
 *  not at Slack, and a Slack outage must never fail a stage change. */
export const announceStageChange = (
  ctx: WorkspaceContext,
  workspaceSlug: string,
  change: StageChange | undefined,
  actorName = 'Somebody',
): void => {
  if (!change) return

  void slackCredentials(ctx)
    .then((creds) => {
      if (!shouldAnnounceStage(creds, change.pipelineId)) return
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
    .catch(() => {
      // Reading the credentials failed, which is already visible as a degraded
      // integration. A stage change is not the place to surface it.
    })
}
