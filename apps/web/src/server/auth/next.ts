/** Only a same-origin path survives, so a sign-in link cannot become an open
 *  redirect. Used to land on the consent screen an assistant sent somebody to. */
export const safeNext = (value: string | null | undefined): string =>
  value && value.startsWith('/') && !value.startsWith('//') ? value : '/'
