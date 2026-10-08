import { publicFormById, publicFormBySlug, type PublicForm } from '@rawr/db'
import { notFound } from 'next/navigation'
import { cache } from 'react'

/** Keyed on the path parts rather than the array, so every caller in one request
 *  (layout, metadata, page) shares one lookup instead of querying the same form again. */
const lookup = cache(
  async (first: string, second?: string): Promise<PublicForm | null> =>
    second === undefined ? publicFormById(first) : publicFormBySlug(first, second),
)

export const resolve = async (path: string[]): Promise<PublicForm | null> => {
  if (path.length === 1 && path[0]) return lookup(path[0])
  if (path.length === 2 && path[0] && path[1]) return lookup(path[0], path[1])
  return null
}

/** Throws the 404 before anything streams, so the status code is a real 404. */
export const activeForm = async (path: string[]): Promise<PublicForm> => {
  const form = await resolve(path)
  if (!form || !form.isActive) notFound()
  return form
}
