import postgres from 'postgres'
import { listAudit } from '../src/dal/audit.ts'
import {
  acceptInvitation,
  deactivateMember,
  hashToken,
  invite,
  listInvitations,
  reactivateMember,
  readAccount,
  revokeInvitation,
  saveAccount,
} from '../src/dal/account.ts'
import type { AccountContext } from '../src/dal/context.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import { ROLE_TEMPLATES, addMember, copyMemberGrants, listMembers, setMemberGrants } from '../src/dal/members.ts'
import { membershipsForUser } from '../src/dal/session.ts'
import { saveTeam, setTeamMembers } from '../src/dal/teams.ts'
import { SANDBOX, cleanup, residueCounts } from './fixture.ts'

/** The account layer: seats, invitations, grants, teams and the history of those
 *  decisions. Every check calls the data access layer directly, so hiding a button
 *  proves nothing here. */

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })

const failures: string[] = []
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const refused = async (fn: () => Promise<unknown>): Promise<string | null> => {
  try {
    await fn()
    return null
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }
}

const ALL_HUBS = ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'] as const

try {
  const [row] = await owner`select id from account where slug = ${SANDBOX.slug}`
  if (!row) throw new Error('Seed the database first: pnpm db:seed')
  const accountId = row.id as string

  // Before anything is written. Every suite empties its residue in `finally`, so
  // rows here are a suite that died, or one whose cleanup no longer covers a table
  // the schema has since gained. Either way the next suite is reading somebody
  // else's leftovers.
  const held = await residueCounts(owner)
  check(
    Object.keys(held).length === 0,
    'the fixture accounts start with no residue from an earlier suite',
    Object.entries(held).map(([table, n]) => `${table}=${n}`).join(' '),
  )

  const seat = async (email: string) => {
    const [found] = await owner`select id from user_account where email = ${email}`
    if (!found) throw new Error(`${email} is not seeded`)
    return found.id as string
  }
  const adminId = await seat('admin@sandbox.test')
  const salesId = await seat('sales@sandbox.test')

  const superAdmin: AccountContext = {
    accountId,
    actorId: adminId,
    actorKind: 'user',
    isSuperAdmin: true,
    viewHubs: [],
    editHubs: [...ALL_HUBS],
  }
  /** Holds every hub and is still not a super admin, which is the distinction the
   *  whole seating layer rests on. */
  const hubAdmin: AccountContext = { ...superAdmin, actorId: salesId, isSuperAdmin: false }

  console.log('-- scope -------------------------------------------------------')

  const account = await readAccount(superAdmin)
  check(account.slug === SANDBOX.slug, 'the account reads its own row', account.slug)
  check(account.hostedDomain === SANDBOX.domain, 'and carries the domain that claims it', account.hostedDomain)
  check(account.seatsUsed > 0, 'seats in use are counted from live memberships', `${account.seatsUsed}`)

  console.log('\n-- seating is a super admin act --------------------------------')

  check(
    (await refused(() => saveAccount(hubAdmin, { name: 'Renamed by a hub admin' }))) !== null,
    'holding every hub does not let you change the account',
  )
  check(
    (await refused(() => invite(hubAdmin, { email: `probe-${Date.now()}@sandbox.test` }))) !== null,
    'nor invite anybody',
  )
  check(
    (await refused(() => deactivateMember(hubAdmin, adminId))) !== null,
    "nor end somebody else's access",
  )

  console.log('\n-- invitations -------------------------------------------------')

  const email = `verify-${Date.now()}@sandbox.test`
  const { token, id: invitationId } = await invite(superAdmin, {
    email,
    editHubs: ['contacts', 'sales'],
  })
  const [stored] = await owner`select token_hash from invitation where id = ${invitationId}`
  check(stored!.token_hash !== token, 'only the hash is stored, never the link')
  check(stored!.token_hash === (await hashToken(token)), 'and the hash is of the token handed back')

  const open = await listInvitations(superAdmin)
  check(open.some((i) => i.email === email), 'the invitation is listed while it is open')

  check(
    (await refused(() => invite(superAdmin, { email }))) !== null,
    'a second invitation to the same address is refused',
  )

  const wrongPerson = await acceptInvitation(token, adminId)
  check(wrongPerson === null, 'a link is refused to anybody but the address it names')

  await revokeInvitation(superAdmin, invitationId)
  check(
    (await listInvitations(superAdmin)).every((i) => i.id !== invitationId),
    'a revoked invitation leaves the open list',
  )
  check((await acceptInvitation(token, adminId)) === null, 'and its link stops working')

  console.log('\n-- grants ------------------------------------------------------')

  const probeEmail = `grant-${Date.now()}@sandbox.test`
  const { userId: probeId } = await addMember(superAdmin, {
    email: probeEmail,
    editHubs: ['contacts'],
  })
  const seated = (await listMembers(superAdmin)).find((m) => m.userId === probeId)
  check(seated?.editHubs.join() === 'contacts', 'a new seat holds exactly what it was given', seated?.editHubs.join())
  check(seated?.isSuperAdmin === false, 'and is not a super admin by default')

  await setMemberGrants(superAdmin, { userId: probeId, viewHubs: ['reports'], editHubs: ['contacts', 'marketing'] })
  const raised = (await listMembers(superAdmin)).find((m) => m.userId === probeId)
  check(raised?.editHubs.sort().join() === 'contacts,marketing', 'grants can be raised', raised?.editHubs.join())
  check(raised?.viewHubs.join() === 'reports', 'and view and edit are kept apart', raised?.viewHubs.join())

  console.log('\n-- critical grants ---------------------------------------------')

  check(
    seated?.criticalGrants.length === 0,
    'a new seat holds none of the critical acts until somebody grants them',
    seated?.criticalGrants.join(),
  )

  await setMemberGrants(superAdmin, {
    userId: probeId,
    editHubs: ['contacts'],
    criticalGrants: ['delete', 'export'],
  })
  const critical = (await listMembers(superAdmin)).find((m) => m.userId === probeId)
  check(
    critical?.criticalGrants.sort().join() === 'delete,export',
    'critical acts are granted one at a time',
    critical?.criticalGrants.join(),
  )
  check(
    (await refused(() => setMemberGrants(superAdmin, { userId: probeId, criticalGrants: ['launch_rockets'] }))) !== null,
    'an act nobody has heard of is refused rather than stored',
  )

  console.log('\n-- role templates and copying ----------------------------------')

  const template = ROLE_TEMPLATES.sales_rep
  await setMemberGrants(superAdmin, { userId: probeId, ...template.grants })
  const templated = (await listMembers(superAdmin)).find((m) => m.userId === probeId)
  check(
    templated?.editHubs.sort().join() === [...template.grants.editHubs].sort().join() &&
      templated?.criticalGrants.sort().join() === [...template.grants.criticalGrants].sort().join(),
    'a role template writes exactly the grants it names',
    `${templated?.editHubs.join()} + ${templated?.criticalGrants.join()}`,
  )
  check(
    Object.values(ROLE_TEMPLATES).every((t) => !(t.grants.criticalGrants as readonly string[]).includes('purge')),
    'no template hands out permanent deletion',
  )

  const copyEmail = `copy-${Date.now()}@sandbox.test`
  const { userId: copyId } = await addMember(superAdmin, { email: copyEmail })
  await copyMemberGrants(superAdmin, { fromUserId: probeId, toUserId: copyId })
  const copied = (await listMembers(superAdmin)).find((m) => m.userId === copyId)
  check(
    copied?.editHubs.sort().join() === templated?.editHubs.sort().join() &&
      copied?.viewHubs.sort().join() === templated?.viewHubs.sort().join() &&
      copied?.criticalGrants.sort().join() === templated?.criticalGrants.sort().join(),
    'copying somebody makes the two seats hold the same thing',
    `${copied?.editHubs.join()} + ${copied?.criticalGrants.join()}`,
  )
  check(
    (await refused(() => copyMemberGrants(superAdmin, { fromUserId: copyId, toUserId: copyId }))) !== null,
    'copying somebody onto themselves is refused',
  )
  check(
    (await refused(() => copyMemberGrants(hubAdmin, { fromUserId: probeId, toUserId: copyId }))) !== null,
    'and holding every hub is not enough to copy anybody',
  )
  const copyAudit = await listAudit(superAdmin, { limit: 20 })
  check(
    copyAudit.rows.some((r) => r.entity === 'membership' && r.action === 'copy_grants'),
    'the copy is recorded as its own act',
  )
  await owner`delete from membership where user_id = ${copyId}`
  await owner`delete from user_account where id = ${copyId}`

  console.log('\n-- the last super admin ----------------------------------------')

  const supers = await owner`select count(*)::int n from membership
    where account_id = ${accountId} and is_super_admin and state = 'active'`
  if ((supers[0]!.n as number) === 1) {
    check(
      (await refused(() => setMemberGrants(superAdmin, { userId: adminId, isSuperAdmin: false }))) !== null,
      'the only super admin cannot demote themselves',
    )
  } else {
    check(true, `skipped: ${supers[0]!.n} super admins seeded`)
  }

  console.log('\n-- ending access -----------------------------------------------')

  await deactivateMember(superAdmin, probeId)
  check(
    (await membershipsForUser(probeId)).length === 0,
    'a deactivated person holds no membership their session can use',
  )
  const [stillThere] = await owner`select id from user_account where id = ${probeId}`
  check(stillThere !== undefined, 'but the row stays, so the audit trail still names them')

  await reactivateMember(superAdmin, probeId)
  check((await membershipsForUser(probeId)).length === 1, 'restoring gives the seat back')

  console.log('\n-- teams -------------------------------------------------------')

  const team = await saveTeam(superAdmin, { name: `Verify ${Date.now()}` })
  await setTeamMembers(superAdmin, { teamId: team.id, members: [{ userId: salesId }] })
  const [teamCount] = await owner`select count(*)::int n from team_member where team_id = ${team.id}`
  check((teamCount!.n as number) === 1, 'a team holds the people put in it')

  console.log('\n-- history -----------------------------------------------------')

  const history = await listAudit(superAdmin, { limit: 50 })
  check(
    history.rows.some((r) => r.entity === 'membership' && r.action === 'deactivate'),
    'ending access is recorded',
  )
  check(
    history.rows.some((r) => r.entity === 'invitation' && r.action === 'invite'),
    'and so is inviting somebody',
  )
  check(
    history.rows.every((r) => r.actorId !== null || r.actorKind !== 'user'),
    'every act by a person names the person',
  )

  await owner`delete from membership where user_id = ${probeId}`
  await owner`delete from user_account where id = ${probeId}`
  await owner`delete from team where id = ${team.id}`

  console.log(`\n${failures.length === 0 ? 'All account checks passed.' : `${failures.length} FAILED`}`)
  for (const f of failures) console.log(`  - ${f}`)
} finally {
  await owner.end()
  await closeAppPool()
  await cleanup()
}

if (failures.length > 0) process.exit(1)
