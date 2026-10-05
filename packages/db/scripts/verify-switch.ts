import { createHmac } from 'node:crypto'
import postgres from 'postgres'
import { closeAppPool } from '../src/internal/pool.ts'
import { PEER, SANDBOX } from './fixture.ts'

/** Which account a request is for, over the wire. Needs the dev server (pnpm dev)
 *  running against the same database and the same AUTH_SECRET.
 *
 *  A tab that is still showing one account must not write into the account the
 *  shared session cookie was moved to, and a link must not move the session. */

const BASE = process.env.RAWR_MCP_BASE ?? 'http://localhost:3000'
const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })

const failures: string[] = []
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const b64 = (value: object | Buffer) => Buffer.from(value instanceof Buffer ? value : JSON.stringify(value)).toString('base64url')
const sign = (claims: object) => {
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, iss: 'rawr', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`
  return `${head}.${b64(createHmac('sha256', process.env.AUTH_SECRET!).update(head).digest())}`
}

const main = async () => {
  const [seat] = await owner<{ user_id: string; account_id: string }[]>`
    select m.user_id, m.account_id from membership m
      join account a on a.id = m.account_id join user_account u on u.id = m.user_id
     where a.slug = ${SANDBOX.slug} and u.email = 'admin@sandbox.test'`
  const [peer] = await owner<{ id: string }[]>`select id from account where slug = ${PEER.slug}`
  if (!seat || !peer) throw new Error('Run pnpm db:seed first: the sandbox admin and the peer account are missing.')
  await owner`insert into membership (account_id, user_id, state, is_super_admin)
    values (${peer.id}, ${seat.user_id}, 'active', true) on conflict do nothing`

  try {
    const cookie = `rawr_session=${sign({ userId: seat.user_id, accountId: seat.account_id, accountSlug: SANDBOX.slug })}`
    const call = (path: string, init: RequestInit = {}) =>
      fetch(BASE + path, { redirect: 'manual', ...init, headers: { cookie, ...(init.headers ?? {}) } })
    const form = { 'content-type': 'application/x-www-form-urlencoded' }
    const read = '/api/trpc/crm.tasks.queues.list'

    check((await call(read)).status === 200, 'a request that names no account is judged by the session')
    check((await call(read, { headers: { 'x-rawr-account': SANDBOX.slug } })).status === 200, 'one naming the session account is answered')
    check((await call(read, { headers: { 'x-rawr-account': PEER.slug } })).status === 409, 'one from a tab showing another account is refused')

    check((await call('/api/auth/account?to=peer')).status === 405, 'the switch is not a link: a GET changes nothing')
    const crossSite = await call('/api/auth/account', { method: 'POST', headers: { ...form, origin: 'http://evil.example' }, body: 'to=peer' })
    check(crossSite.status === 403 && !crossSite.headers.get('set-cookie'), 'nor a POST from another origin')

    const link = await call(`/contacts/${PEER.slug}/home`)
    check(link.status === 307 && (link.headers.get('location') ?? '').includes('/switch?'), 'a link into another account asks before switching')
    check(!link.headers.get('set-cookie'), 'and leaves the session where it was')

    const chosen = await call('/api/auth/account', { method: 'POST', headers: { ...form, origin: BASE }, body: `to=${PEER.slug}&next=/contacts/${PEER.slug}/home` })
    check(chosen.status === 303 && /rawr_session=/.test(chosen.headers.get('set-cookie') ?? ''), 'choosing to switch moves the session')
  } finally {
    await owner`delete from membership where account_id = ${peer.id} and user_id = ${seat.user_id}`
  }
}

main()
  .catch((error) => {
    console.error('the suite could not finish:', error)
    failures.push('suite crashed')
  })
  .finally(async () => {
    await owner.end()
    await closeAppPool()
    if (failures.length) {
      console.log(`\n${failures.length} FAILED`)
      process.exit(1)
    }
    console.log('\nall checks passed')
  })
