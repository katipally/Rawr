import postgres from 'postgres'

/** Proves the three isolation claims against the real database rather than
 *  asserting them. Exits non-zero on any failure, so it can gate a build. */

const owner = postgres(process.env.DATABASE_URL_OWNER!, { max: 1, onnotice: () => {} })
const app = postgres(process.env.DATABASE_URL_SESSION!, { max: 1, onnotice: () => {} })

const failures: string[] = []
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

try {
  const unprotected = await owner`
    select c.relname,
           c.relrowsecurity as rls,
           c.relforcerowsecurity as forced,
           (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and (not c.relrowsecurity or not c.relforcerowsecurity
            or not exists (select 1 from pg_policy p where p.polrelid = c.oid))
     order by c.relname`
  check(
    unprotected.length === 0,
    'every public table has row level security enabled, forced, and at least one policy',
    unprotected.length ? `offenders: ${unprotected.map((r) => r.relname).join(', ')}` : '',
  )

  const [appRole] = await owner`
    select rolbypassrls as bypass,
           (select count(*) from pg_class c
              join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relowner = r.oid) as owns
      from pg_roles r where r.rolname = 'rawr_app'`
  check(appRole?.bypass === false, 'the app role cannot bypass row level security')
  check(Number(appRole?.owns) === 0, 'the app role owns no tables, so FORCE actually binds')

  const [appDbRole] = await app`select current_user as who`
  check(appDbRole?.who === 'rawr_app', 'the application connection is the app role, not the owner')

  // Two probe workspaces, each under its own organisation: the domain lives on
  // the organisation now, and a workspace cannot exist without one.
  const stamp = Date.now()
  const orgA = (await owner`
    insert into organisation (name, slug, google_hosted_domain)
    values ('Probe Org A', ${'probe-org-a-' + stamp}, ${'a-' + stamp + '.example'})
    returning id`)[0]!.id
  const orgB = (await owner`
    insert into organisation (name, slug, google_hosted_domain)
    values ('Probe Org B', ${'probe-org-b-' + stamp}, ${'b-' + stamp + '.example'})
    returning id`)[0]!.id
  const wsA = (await owner`
    insert into workspace (organisation_id, name, slug)
    values (${orgA}, 'Probe A', ${'probe-a-' + stamp})
    returning id`)[0]!.id
  const wsB = (await owner`
    insert into workspace (organisation_id, name, slug)
    values (${orgB}, 'Probe B', ${'probe-b-' + stamp})
    returning id`)[0]!.id
  await owner`insert into company (workspace_id, name) values (${wsA}, 'Company in A')`
  await owner`insert into company (workspace_id, name) values (${wsB}, 'Company in B')`

  const unscoped = await app`select count(*)::int as n from company`
  check(unscoped[0]?.n === 0, 'a query with no workspace set returns zero rows')

  const scoped = await app.begin(async (tx) => {
    await tx`select set_config('rawr.workspace_id', ${wsA}, true)`
    return tx`select name from company order by name`
  })
  check(
    scoped.length === 1 && scoped[0]?.name === 'Company in A',
    'scoped as workspace A, only workspace A rows are visible',
    `saw: ${scoped.map((r) => r.name).join(', ') || 'nothing'}`,
  )

  let crossTenantWriteBlocked = false
  try {
    await app.begin(async (tx) => {
      await tx`select set_config('rawr.workspace_id', ${wsA}, true)`
      await tx`insert into company (workspace_id, name) values (${wsB}, 'smuggled')`
    })
  } catch {
    crossTenantWriteBlocked = true
  }
  check(crossTenantWriteBlocked, 'authenticated as A, writing a row tagged B is refused')

  let auditImmutable = false
  try {
    await app.begin(async (tx) => {
      await tx`select set_config('rawr.workspace_id', ${wsA}, true)`
      await tx`update audit_log set action = 'tampered'`
    })
  } catch {
    auditImmutable = true
  }
  check(auditImmutable, 'the app role cannot update audit_log')

  // The organisations cascade to their workspaces, which cascade to the rows.
  await owner`delete from organisation where id in (${orgA}, ${orgB})`
} finally {
  await owner.end()
  await app.end()
}

if (failures.length) {
  console.error(`\n${failures.length} tenancy check(s) failed.`)
  process.exit(1)
}
console.log('\nall tenancy checks passed.')
