import { PageHeader } from '@rawr/ui'
import { listLifecycleStages } from '@rawr/db'
import { contextFrom, readSession } from '~/server/session.ts'
import { OrderedList } from '../ordered-list.tsx'

/** A2: the lifecycle list is ordered, editable and reorderable, and a change on a
 *  record writes its own timeline event. The list itself lives here. */
const LifecyclePage = async () => {
  const session = await readSession()
  if (!session) return null

  const stages = await listLifecycleStages(contextFrom(session))

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        as="h2"
        title="Lifecycle stages"
        lead="The ordered list a contact or a company moves along."
        why={
          <p>
            Order carries meaning: a lifecycle runs in one direction, and moving backwards is a
            thing worth seeing on a timeline. Every change on a record writes its own entry,
            forwards or backwards.
          </p>
        }
      />

      <OrderedList
        rows={stages.map((stage) => ({
          id: stage.id,
          name: stage.name,
          detail:
            stage.usedBy === 0
              ? 'On no records'
              : `On ${stage.usedBy.toLocaleString()} record${stage.usedBy === 1 ? '' : 's'}`,
          usedBy: stage.usedBy,
        }))}
        canWrite={session.role === 'admin'}
        role={session.role}
        noun="lifecycle stage"
        namespace="lifecycle"
      />
    </div>
  )
}

export default LifecyclePage
