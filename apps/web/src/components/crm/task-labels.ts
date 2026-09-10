/** Task vocabulary shared by the create/edit form and by the server-rendered
 *  index that filters on it. It lives outside the client form because a server
 *  component that imports a value from a "use client" module gets a client
 *  reference, not the object, and iterating one yields nothing. */

export type TaskType = 'todo' | 'call' | 'email'
export type TaskPriority = 'low' | 'medium' | 'high'

/** HubSpot's three, in the order its own dropdown offers them. */
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  todo: 'To-do',
  call: 'Call',
  email: 'Email',
}

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}
