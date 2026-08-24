import { membershipsForGoogleSub, type Membership, type WorkspaceContext } from '@rawr/db'
import { jwtVerify, SignJWT } from 'jose'
import { cookies } from 'next/headers'
import { env } from '~/lib/env.ts'

const COOKIE = 'rawr_session'
const ISSUER = 'rawr'
const MAX_AGE_SECONDS = 60 * 60 * 12

const key = new TextEncoder().encode(env.AUTH_SECRET)

export type Session = {
  googleSub: string
  userId: string
  email: string
  displayName: string
  avatarUrl: string | null
  workspaceId: string
  workspaceSlug: string
  workspaceName: string
  role: Membership['role']
}

export const sessionFromMembership = (googleSub: string, m: Membership): Session => ({
  googleSub,
  userId: m.userId,
  email: m.email,
  displayName: m.displayName,
  avatarUrl: m.avatarUrl,
  workspaceId: m.workspaceId,
  workspaceSlug: m.workspaceSlug,
  workspaceName: m.workspaceName,
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
 *  on their next request rather than when their token expires. */
export const readSession = async (): Promise<Session | null> => {
  const jar = await cookies()
  const token = jar.get(COOKIE)?.value
  if (!token) return null

  let claims: Session
  try {
    const { payload } = await jwtVerify<Session>(token, key, { issuer: ISSUER })
    claims = payload
  } catch {
    return null
  }

  const memberships = await membershipsForGoogleSub(claims.googleSub)
  const current = memberships.find((m) => m.workspaceId === claims.workspaceId)
  if (!current) return null

  return sessionFromMembership(claims.googleSub, current)
}

export const contextFrom = (session: Session): WorkspaceContext => ({
  workspaceId: session.workspaceId,
  actorId: session.userId,
  actorKind: 'user',
  role: session.role,
})
