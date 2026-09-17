import postgres from 'postgres'
import type { AccountContext } from '../src/dal/context.ts'
import { getPrefs, setPref } from '../src/dal/preferences.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import { SANDBOX, PEER } from './fixture.ts'

/** What used to live only in localStorage, proved by writing and reading it
 *  rather than by looking at a rail. Every check here is one way this table goes
 *  wrong quietly: one person's write landing on another's row, a value that does
 *  not round trip through JSONB, or `getPrefs` costing one query per key. */

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })

const failures: string[] = []
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const contextFor = (accountId: string, actorId: string | null): AccountContext => ({
  accountId,
  actorId,
  actorKind: 'user',
  isSuperAdmin: true,
  viewHubs: [],
  editHubs: ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'],
})

const wipe = async (accountId: string) =>
  owner`delete from preference where account_id = ${accountId} and key like 'verify:%'`

try {
  const [ws] = await owner`select id from account where slug = ${SANDBOX.slug}`
  const [other] = await owner`select id from account where slug = ${PEER.slug}`
  if (!ws || !other) throw new Error('Seed the database first: pnpm db:seed')
  const accountId = ws.id as string
  const otherAccountId = other.id as string

  const people = await owner`
    select u.id from user_account u
      join membership m on m.user_id = u.id
     where m.account_id = ${accountId}
     order by u.name limit 2`
  if (people.length < 2) throw new Error('This needs two members in datasaur.')
  const [alice, bob] = people.map((row) => row.id as string) as [string, string]

  await wipe(accountId)

  const [rls] = await owner`
    select relrowsecurity as enabled, relforcerowsecurity as forced
      from pg_class where oid = 'public.preference'::regclass`
  check(
    rls?.enabled === true && rls?.forced === true,
    'row level security is on and forced',
    'apply_tenancy() picked the table up from its account_id, with no hand-written policy',
  )

  const [granted] = await owner`
    select has_table_privilege('rawr_app', 'public.preference', 'select, insert, update, delete') as ok`
  check(granted?.ok === true, 'rawr_app can read and write the table')

  const aliceCtx = contextFor(accountId, alice)
  const bobCtx = contextFor(accountId, bob)

  // ------------------------------------------------------------ round trip

  await setPref(aliceCtx, 'verify:railExpanded', true)
  await setPref(aliceCtx, 'verify:bookmarks', [{ href: '/a', label: 'A' }])
  const read = await getPrefs(aliceCtx)
  check(read['verify:railExpanded'] === true, 'a boolean value round trips')
  check(
    Array.isArray(read['verify:bookmarks']) &&
      (read['verify:bookmarks'] as { href: string }[])[0]?.href === '/a',
    'a JSON array value round trips',
  )

  // ------------------------------------------------------------ upsert

  await setPref(aliceCtx, 'verify:railExpanded', false)
  const [row] = await owner`
    select count(*)::int as n from preference
     where account_id = ${accountId} and user_id = ${alice} and key = 'verify:railExpanded'`
  check(row?.n === 1, 'writing the same key twice updates the one row, not a second one')
  const reread = await getPrefs(aliceCtx)
  check(reread['verify:railExpanded'] === false, 'the update is what the next read sees')

  // ------------------------------------------------------------ one query

  await setPref(aliceCtx, 'verify:recent', [])
  await setPref(aliceCtx, 'verify:timelineKinds', {})
  const all = await getPrefs(aliceCtx)
  check(
    'verify:railExpanded' in all && 'verify:bookmarks' in all && 'verify:recent' in all && 'verify:timelineKinds' in all,
    'getPrefs returns every key for this person in one call',
  )

  // ------------------------------------------------------------ isolation

  await setPref(bobCtx, 'verify:railExpanded', true)
  const bobRead = await getPrefs(bobCtx)
  check(
    bobRead['verify:railExpanded'] === true && (await getPrefs(aliceCtx))['verify:railExpanded'] === false,
    'one person writing a key never changes what another person reads for the same key',
  )

  const acrossAccount = await getPrefs(contextFor(otherAccountId, alice))
  check(
    !('verify:railExpanded' in acrossAccount),
    'the same person id, pinned to another account, sees none of it',
  )

  // ------------------------------------------------------------ no session

  const noActor = await getPrefs(contextFor(accountId, null))
  check(Object.keys(noActor).length === 0, 'a context with no actor reads nothing rather than erroring')
  await setPref(contextFor(accountId, null), 'verify:should-not-write', true)
  const [none] = await owner`select count(*)::int as n from preference where key = 'verify:should-not-write'`
  check(none?.n === 0, 'a context with no actor writes nothing')

  await wipe(accountId)
} finally {
  await owner.end()
  await closeAppPool()
}

console.log(failures.length === 0 ? '\nAll preference checks passed.' : `\n${failures.length} failed.`)
process.exit(failures.length === 0 ? 0 : 1)
