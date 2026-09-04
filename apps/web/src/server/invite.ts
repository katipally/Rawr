/** The invitation a browser is carrying while it goes and signs in. It is a
 *  credential, so it is httpOnly and short-lived; the sign-in handlers read it
 *  once and delete it whether or not it worked. */
export const INVITE_COOKIE = 'rawr_invite'

/** Long enough to sign in with Google, including a password and a second factor.
 *  Not long enough to sit in a shared browser afterwards. */
export const INVITE_COOKIE_MAX_AGE_SECONDS = 15 * 60
