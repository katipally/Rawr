import { membershipsForUser, type Membership, type WorkspaceContext } from '@rawr/db'
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
  workspaceId: string
  workspaceSlug: string
  workspaceName: string
  hostedDomain: string
  role: Membership['role']
}

export const sessionFromMembership = (m: Membership): Session => ({
  userId: m.userId,
  email: m.email,
  displayName: m.displayName,
  avatarUrl: m.avatarUrl,
  workspaceId: m.workspaceId,
  workspaceSlug: m.workspaceSlug,
  workspaceName: m.workspaceName,
  hostedDomain: m.hostedDomain,
  role: m.role,
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
 *  exists and re-reads the role from the database, so a revoked person loses access
 *  on their next request rather than when their token expires.
 *
 *  Deduplicated per request, not cached across them: the layout and the page both
 *  ask, and several pages ask again inside a helper, so one screen was paying for
 *  the same membership query three or four times over. `cache` is scoped to a
 *  single render, so a revoked role still takes effect on the very next request. */
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

  const current = (await memberships(claims.userId)).find((m) => m.workspaceId === claims.workspaceId)
  if (!current) return null
  // "Sign out everywhere" moves the watermark; a cookie minted before it is dead
  // even though its signature still checks out.
  // iat has second precision, so a cookie minted in the same second as the
  // watermark is given the whole second: a sign-in right after signing out
  // everywhere must not be refused by its own rounding.
  if (current.sessionsValidAfter && ((claims.iat ?? 0) + 1) * 1000 <= current.sessionsValidAfter.getTime()) return null

  return sessionFromMembership(current)
})

export const contextFrom = (session: Session): WorkspaceContext => ({
  workspaceId: session.workspaceId,
  actorId: session.userId,
  actorKind: 'user',
  role: session.role,
})
