import postgres from 'postgres'
import { listAudit } from '../src/dal/audit.ts'
import type { WorkspaceContext } from '../src/dal/context.ts'
import { closeAppPool } from '../src/internal/pool.ts'
import {
  acceptInvitation,
  createWorkspace,
  deactivateMember,
  hashToken,
  invite,
  listOrgMembers,
  listOrgWorkspaces,
  reactivateMember,
  readOrganisation,
  revokeInvitation,
  saveOrganisation,
  setOrgRole,
  type OrganisationContext,
} from '../src/dal/organisation.ts'
import { membershipsForUser } from '../src/dal/session.ts'
import { saveTeam, setTeamMembers } from '../src/dal/teams.ts'

/** The organisation layer: its own scope, its own policies, and the invariants
 *  that keep a company administrable. Every check calls the data access layer
 *  directly, so hiding a button proves nothing here. */

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

try {
  const [datasaurOrg] = await owner`select id, name from organisation where slug = 'datasaur'`
  const [probeOrg] = await owner`select id from organisation where slug = 'probe'`
  if (!datasaurOrg || !probeOrg) throw new Error('Seed the database first: pnpm db:seed')

  const [adminUser] = await owner`select id from user_account where email = 'admin@datasaur.ai'`
  const [salesUser] = await owner`select id from user_account where email = 'sales@datasaur.ai'`
  const [formerUser] = await owner`select id from user_account where email = 'former@datasaur.ai'`
  const [probeUser] = await owner`select id from user_account where email = 'admin@probe.example'`
  const [datasaurWs] = await owner`select id from workspace where slug = 'datasaur'`

  const orgAdmin: OrganisationContext = {
    organisationId: datasaurOrg.id as string,
    actorId: adminUser!.id as string,
    actorKind: 'user',
    orgRole: 'org_admin',
  }
  const orgMember: OrganisationContext = { ...orgAdmin, actorId: salesUser!.id as string, orgRole: 'member' }
  const probeAdmin: OrganisationContext = {
    organisationId: probeOrg.id as string,
    actorId: probeUser!.id as string,
    actorKind: 'user',
    orgRole: 'org_admin',
  }

  console.log('-- scope ---------------------------------------------------------')

  const [rls] = await owner`
    select bool_and(relrowsecurity and relforcerowsecurity) as forced
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('organisation', 'organisation_membership', 'invitation',
                         'organisation_audit_log', 'team', 'team_member')`
  check(rls?.forced === true, 'row level security is forced on every organisation table')

  const mine = await listOrgWorkspaces(orgAdmin)
  const theirs = await listOrgWorkspaces(probeAdmin)
  check(mine.length === 2, 'an organisation sees the workspaces it owns', `${mine.length} of 2`)
  check(theirs.length === 1, 'the other organisation sees only its own', `${theirs.length} of 1`)
  check(
    !mine.some((row) => theirs.some((other) => other.id === row.id)),
    'no workspace appears in both organisations',
  )

  const org = await readOrganisation(orgAdmin)
  check(org.hostedDomain === 'datasaur.ai', 'the hosted domain is read from the organisation', org.hostedDomain)

  console.log('')
  console.log('-- who may change what -------------------------------------------')

  check(
    (await refused(() => saveOrganisation(orgMember, { name: 'Nope' })))?.includes('organisation admin') === true,
    'a member cannot change the organisation',
  )
  check(
    (await refused(() => createWorkspace(orgMember, { name: 'Nope', slug: 'nope' })))?.includes('organisation admin') ===
      true,
    'a member cannot create a workspace',
  )

  const workspaceCtx = (role: WorkspaceContext['role']): WorkspaceContext => ({
    workspaceId: datasaurWs!.id as string,
    actorId: adminUser!.id as string,
    actorKind: 'user',
    role,
  })
  check(
    (await refused(() => saveTeam(workspaceCtx('sales'), { name: 'Sales cannot' })))?.includes('cannot change') === true,
    'sales cannot create a team',
  )
  check((await refused(() => saveTeam(workspaceCtx('admin'), { name: 'Verify team' }))) === null, 'admin can create a team')

  console.log('')
  console.log('-- seats and access ----------------------------------------------')

  const beforeSeats = await readOrganisation(orgAdmin)
  await saveOrganisation(orgAdmin, { seatLimit: beforeSeats.seatsUsed })
  const capped = await refused(() => invite(orgAdmin, { email: `seat-${Date.now()}@datasaur.ai` }))
  check(capped?.includes('seats are taken') === true, 'an invitation is refused when every seat is taken', capped ?? '')
  await saveOrganisation(orgAdmin, { seatLimit: beforeSeats.seatLimit })

  const address = `verify-${Date.now()}@datasaur.ai`
  const made = await invite(orgAdmin, {
    email: address,
    workspaceId: datasaurWs!.id as string,
    workspaceRole: 'sales',
  })
  check(made.token.length >= 40, 'an invitation returns a token exactly once')

  const [stored] = await owner`select token_hash from invitation where id = ${made.id}`
  check(
    stored?.token_hash === (await hashToken(made.token)) && stored?.token_hash !== made.token,
    'only the hash of the token is stored',
  )

  const twice = await refused(() => invite(orgAdmin, { email: address }))
  check(twice?.includes('already has an open invitation') === true, 'the same address cannot be invited twice over')

  // Somebody signing in with a different address must not be seated by the link.
  const wrongPerson = await acceptInvitation(made.token, salesUser!.id as string)
  check(wrongPerson === null, 'a link cannot seat an address it was not written for')

  const [invitee] = await owner`
    insert into user_account (email, name) values (${address}, 'Verify Invitee')
    on conflict (email) do update set name = excluded.name returning id`
  const first = await acceptInvitation(made.token, invitee!.id as string)
  const second = await acceptInvitation(made.token, invitee!.id as string)
  check(first === (datasaurOrg.id as string), 'accepting an invitation seats the person')
  check(second === null, 'accepting the same invitation twice does nothing the second time')

  const [seats] = await owner`
    select count(*)::int as n from membership
     where user_id = ${invitee!.id} and workspace_id = ${datasaurWs!.id}`
  check(seats?.n === 1, 'accepting seats them exactly once', `${seats?.n} row(s)`)

  const deactivatedMemberships = await membershipsForUser(formerUser!.id as string)
  check(
    deactivatedMemberships.length === 0,
    'a deactivated person holds no memberships, so their next request has no session',
    `${deactivatedMemberships.length} returned`,
  )

  const self = await refused(() => deactivateMember(orgAdmin, adminUser!.id as string))
  check(self?.includes('cannot deactivate yourself') === true, 'an admin cannot end their own access')

  const onlyAdmin = await refused(() => setOrgRole(orgAdmin, { userId: adminUser!.id as string, role: 'member' }))
  check(onlyAdmin?.includes('only organisation admin') === true, 'the last organisation admin cannot be demoted')

  console.log('')
  console.log('-- history --------------------------------------------------------')

  const [audited] = await owner`
    select count(*)::int as n from organisation_audit_log
     where organisation_id = ${datasaurOrg.id} and entity = 'invitation' and action = 'invite'`
  check((audited?.n ?? 0) > 0, 'an organisation change writes an organisation audit row')

  const page = await listAudit(workspaceCtx('admin'), { limit: 5 })
  check(page.rows.length > 0, 'the workspace history reads back', `${page.rows.length} rows`)
  const older = page.cursor ? await listAudit(workspaceCtx('admin'), { limit: 5, cursor: page.cursor }) : { rows: [] }
  check(
    !older.rows.some((row) => page.rows.some((first) => first.id === row.id)),
    'the keyset page does not repeat a row it already showed',
  )
  check(
    (await refused(() => listAudit(workspaceCtx('sales'), { limit: 5 })))?.includes('admin') === true,
    'a salesperson cannot read the history',
  )

  console.log('')
  console.log('-- teams -----------------------------------------------------------')

  const team = await saveTeam(workspaceCtx('admin'), { name: `Verify team ${Date.now()}` })
  await setTeamMembers(workspaceCtx('admin'), {
    teamId: team.id,
    members: [{ userId: salesUser!.id as string, isLead: true }],
  })
  const [teamCount] = await owner`select count(*)::int as n from team_member where team_id = ${team.id}`
  check(teamCount?.n === 1, 'setting a team replaces its whole membership', `${teamCount?.n} member(s)`)
  check(
    (await refused(() => setTeamMembers(workspaceCtx('marketing'), { teamId: team.id, members: [] })))?.includes(
      'cannot change',
    ) === true,
    'marketing cannot change who is on a team',
  )

  const members = await listOrgMembers(orgAdmin)
  check(
    members.some((row) => row.state === 'deactivated'),
    'the members list still names somebody whose access ended',
  )

  // Everything this script made goes with it.
  await revokeInvitation(orgAdmin, made.id).catch(() => {})
  await reactivateMember(orgAdmin, formerUser!.id as string).catch(() => {})
  await deactivateMember(orgAdmin, formerUser!.id as string).catch(() => {})
  await owner`delete from team where workspace_id = ${datasaurWs!.id} and name like 'Verify team%'`
  await owner`delete from team where workspace_id = ${datasaurWs!.id} and name = 'Sales cannot'`
  await owner`delete from user_account where email = ${address}`
} finally {
  await Promise.all([owner.end(), closeAppPool()])
}

if (failures.length) {
  console.error(`\n${failures.length} organisation check(s) failed.`)
  process.exit(1)
}
console.log('\nall organisation checks passed.')
