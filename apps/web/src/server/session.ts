import { membershipsForUser, type AccountContext, type Hub, type Membership } from '@rawr/db'
import { jwtVerify, SignJWT } from 'jose'
import { cookies } from 'next/headers'
import { cache } from 'react'
import { env } from '~/lib/env.ts'

const COOKIE = 'rawr_session'
const ISSUER = 'rawr'
const MAX_AGE_SECONDS = 60 * 60 * 12

const key = new TextEncoder().encode(env.AUTH_SECRET)

/** One membership query per request, however many of the layout, the page and
 *  their helpers ask. */
export const memberships = cache(membershipsForUser)

export type Session = {
  userId: string
  email: string
  displayName: string
  avatarUrl: string | null
  accountId: string
  accountSlug: string
  accountName: string
  hostedDomain: string
  isSuperAdmin: boolean
  viewHubs: Hub[]
  editHubs: Hub[]
}

export const sessionFromMembership = (m: Membership): Session => ({
  userId: m.userId,
  email: m.email,
  displayName: m.displayName,
  avatarUrl: m.avatarUrl,
  accountId: m.accountId,
  accountSlug: m.accountSlug,
  accountName: m.accountName,
  hostedDomain: m.hostedDomain,
  isSuperAdmin: m.isSuperAdmin,
  viewHubs: m.viewHubs,
  editHubs: m.editHubs,
})

export const writeSessionCookie = async (session: Session): Promise<void> => {
  const token = await new SignJWT({ ...session })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(key)

  const jar = await cookies()
  jar.set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  })
}

export const clearSessionCookie = async (): Promise<void> => {
  const jar = await cookies()
  jar.delete(COOKIE)
}

/** The cookie is a claim, not proof. Every read re-checks that the membership still
 *  exists and re-reads the grants from the database, so a revoked person loses
 *  access on their next request rather than when their token expires.
 *
 *  Deduplicated per request, not cached across them: the layout and the page both
 *  ask, and several pages ask again inside a helper, so one screen was paying for
 *  the same membership query three or four times over. `cache` is scoped to a
 *  single render, so a revoked grant still takes effect on the very next request. */
export const readSession = cache(async (): Promise<Session | null> => {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null

  let claims: Session & { iat?: number }
  try {
    const { payload } = await jwtVerify<Session>(token, key, { issuer: ISSUER })
    claims = payload
  } catch {
    return null
  }

  const current = (await memberships(claims.userId)).find((m) => m.accountId === claims.accountId)
  if (!current) return null
  // "Sign out everywhere" moves the watermark; a cookie minted before it is dead
  // even though its signature still checks out.
  // iat has second precision, so a cookie minted in the same second as the
  // watermark is given the whole second: a sign-in right after signing out
  // everywhere must not be refused by its own rounding.
  if (current.sessionsValidAfter && ((claims.iat ?? 0) + 1) * 1000 <= current.sessionsValidAfter.getTime()) return null

  return sessionFromMembership(current)
})

export const contextFrom = (session: Session): AccountContext => ({
  accountId: session.accountId,
  actorId: session.userId,
  actorKind: 'user',
  isSuperAdmin: session.isSuperAdmin,
  viewHubs: session.viewHubs,
  editHubs: session.editHubs,
})

/** The same two questions the data access layer asks, for screens deciding what to
 *  render. Never the only gate: every write is checked again in the layer. */
export const sessionCanEdit = (session: Session, hub: Hub): boolean =>
  session.isSuperAdmin || session.editHubs.includes(hub)

export const sessionCanView = (session: Session, hub: Hub): boolean =>
  sessionCanEdit(session, hub) || session.viewHubs.includes(hub)

/** Holds the account hub: may act on rows that are somebody else's, and open the
 *  settings that shape the account. */
export const sessionIsAdmin = (session: Session): boolean => sessionCanEdit(session, 'account')

/** Writes nothing anywhere. What used to be the viewer role. */
export const sessionIsReadOnly = (session: Session): boolean =>
  !session.isSuperAdmin && session.editHubs.length === 0
