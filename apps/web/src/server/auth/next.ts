import { safePath } from '~/lib/links.ts'

/** Only a path on this site survives, so a sign-in link cannot become an open
 *  redirect. Used to land on the consent screen an assistant sent somebody to. */
export const safeNext = (value: string | null | undefined): string => safePath(value)
