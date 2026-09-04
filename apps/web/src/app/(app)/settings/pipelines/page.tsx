import { PageHeader } from '@rawr/ui'
import { listPipelines } from '@rawr/db'
import { contextFrom, readSession } from '~/server/session.ts'
import { PipelineEditor } from './pipeline-editor.tsx'

/** F1's edge case, made real: "a stage is deleted while deals sit in it → blocked,
 *  deletion requires choosing a destination stage, and the move writes a
 *  stage_change per deal." None of that could happen while there was no way to
 *  delete a stage at all. */
const PipelinesPage = async () => {
  const session = await readSession()
  if (!session) return null

  const pipelines = await listPipelines(contextFrom(session))

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Pipelines"
        lead="The stages a deal moves through, and the probability each one carries."
        why={
          <p>
            Weighted totals on the board are computed from these on every read, so changing a
            probability is immediate and nothing stored goes stale.
          </p>
        }
      />

      <PipelineEditor
        pipelines={pipelines}
        canWrite={session.role === 'admin'}
        role={session.role}
      />
    </div>
  )
}

export default PipelinesPage
