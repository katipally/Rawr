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
      <div className="max-w-2xl">
        <h2 className="text-base font-medium">Pipelines</h2>
        <p className="text-secondary">
          The stages a deal moves through, and the probability each one carries. Weighted totals
          on the board are computed from these on every read, so changing a probability is
          immediate and nothing stored goes stale.
        </p>
      </div>

      <PipelineEditor
        pipelines={pipelines}
        canWrite={session.role === 'admin'}
        role={session.role}
      />
    </div>
  )
}

export default PipelinesPage
