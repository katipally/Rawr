import type { TaskView } from './links.ts'

/** The line under an empty task list. A filter is the reason when one is set;
 *  otherwise only the All tab, for someone who can add a task, is pointed at the
 *  button, because the other tabs' titles already say what they are empty of. */
export const emptyTaskHint = ({ filtered, view, canWrite }: { filtered: boolean; view: TaskView; canWrite: boolean }): string | undefined => {
  if (filtered) return 'Widen the search, pick a different type, or clear the filter to see the rest of the tasks.'
  if (view === 'all' && canWrite) return 'Add one with the button above.'
  return undefined
}

/** Deleting a queue sends every task in it to no queue, completed ones included. */
export const queueDeleteCopy = (openCount: number, count: (n: number) => string): string => {
  const rest = 'Nothing is deleted but the list itself.'
  if (openCount === 0) return `This queue has no open tasks. ${rest}`
  if (openCount === 1) return `${count(1)} open task in it goes back to no queue, and so does any completed one. ${rest}`
  return `${count(openCount)} open tasks in it go back to no queue, and so do any completed ones. ${rest}`
}
