/** Sentences a redirect may ask a page to show. The address carries a code, never
 *  the words: a page that printed `?error=` text would let anybody put their own
 *  sentence on a real Rawr page, the sign-in page included. */
export const NOTICE_PARAM = 'notice'

export const NOTICES = {
  signed_out_everywhere: 'Signed out everywhere. Sign in again to continue.',
  sign_in_first: 'Sign in to open that link.',
  signin_cancelled: 'Google sign-in was cancelled.',
  signin_incomplete: 'That sign-in link is incomplete. Start again from the sign-in page.',
  signin_unconfirmed: 'Google would not confirm that sign-in. Start again.',
  email_unverified: 'That Google account has an unverified email address.',
  domain_not_allowed: 'That Google account is not in the domain Rawr is limited to.',
  no_account_for_domain: 'That Google account signed in, but no account exists for its domain and one could not be opened. Ask an admin to invite you.',
  no_seat: 'That Google account signed in, but has no seat. Ask an admin to invite you from Settings, Users & Teams.',
  attempt_mismatch: 'That attempt did not match this browser. Start again.',
  account_not_member: 'That link belongs to an account you do not have a seat in.',
  invite_not_accepted:
    'That invitation could not be accepted. It may have been used already or replaced. Ask whoever invited you to send another.',
  gmail_denied: 'Gmail access was not granted, so no history can be read for you.',
  gmail_incomplete: 'That link is incomplete. Start again from the mailboxes screen.',
  gmail_no_refresh_token:
    'Google did not return a refresh token, so the back-fill would stop within the hour. Remove Rawr from your Google account permissions and connect again.',
  mailbox_failed: 'That mailbox could not be connected. Start again, and ask an admin to check the server log if it keeps failing.',
  calendar_denied: 'Calendar access was not granted, so no times can be offered for you yet.',
  calendar_incomplete: 'That calendar link is incomplete. Start again from the calendars screen.',
  calendar_no_refresh_token:
    'Google did not return a refresh token, so this connection would stop working within the hour. Remove Rawr from your Google account permissions and connect again.',
  calendar_failed: 'That calendar could not be connected. Start again, and ask an admin to check the server log if it keeps failing.',
} as const

export type NoticeCode = keyof typeof NOTICES

/** Only own keys: `toString` and `__proto__` are reachable on a plain object. */
export const noticeFor = (code: unknown): string | null =>
  typeof code === 'string' && Object.hasOwn(NOTICES, code) ? NOTICES[code as NoticeCode] : null
