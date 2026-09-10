import { sql } from 'drizzle-orm'
import { appDb, closeAppPool } from '../src/internal/pool.ts'
import {
  answersFingerprint,
  applyChallenge,
  assertSchemaIsUsable,
  confirmSpam,
  CONFIRMED_SPAM_AT,
  FORM_RESERVED_KEYS,
  hashIp,
  listForms,
  listSubmissions,
  publicEdgeContext,
  publicFormById,
  publicFormBySlug,
  cloneForm,
  countFormView,
  deleteFormFolder,
  formPerformance,
  getForm,
  listFormFolders,
  moveFormToFolder,
  saveFormFolder,
  type FormField,
  QUARANTINE_AT,
  readAttribution,
  readSchema,
  releaseSubmission,
  saveForm,
  scoreSubmission,
  sourceFrom,
  submitForm,
  validateAnswers,
  withAccount,
  type AccountContext,
} from '../src/index.ts'
import { PEER, SANDBOX, seatFor, cleanup } from './fixture.ts'

/** F3's definition of done, run against the real database, exiting non-zero on
 *  failure so it can gate a build. Same shape as verify-crm.ts. */

let failures = 0
let checks = 0

const pass = (what: string, detail?: string) => {
  checks++
  console.log(`PASS  ${what}${detail ? `  ${detail}` : ''}`)
}

const fail = (what: string, detail: string) => {
  checks++
  failures++
  console.log(`FAIL  ${what}\n      ${detail}`)
}

const check = (what: string, condition: boolean, detail?: string) => {
  if (condition) pass(what, detail)
  else fail(what, detail ?? 'condition was false')
}

const section = (title: string) => console.log(`\n-- ${title} ${'-'.repeat(Math.max(0, 60 - title.length))}`)

const ctxFor = async (slug: string, editHubs: string[] = ['contacts', 'sales', 'marketing', 'service', 'reports', 'account']): Promise<AccountContext> => {
  const rows = await appDb.execute<{ id: string }>(
    sql`select id from rawr.account_for_site(${slug})`,
  )
  const id = rows[0]?.id
  if (!id) throw new Error(`account ${slug} is not seeded. Run pnpm db:seed.`)
  // Seated on a real member, because this context writes and every write names
  // its actor in audit_log.
  return { accountId: id, actorId: await seatFor(id, slug), actorKind: 'user', isSuperAdmin: false, viewHubs: [], editHubs: editHubs as AccountContext['editHubs'] }
}

/** Reads go through the tenant-scoped path, exactly as the app does. An unscoped
 *  appDb.execute here would return zero rows under forced row level security and
 *  make every assertion look like a product failure rather than a harness one. */
const scoped = <T extends Record<string, unknown>>(
  ctx: AccountContext,
  query: ReturnType<typeof sql>,
): Promise<T[]> =>
  withAccount(ctx, (tx) => tx.execute<T>(query) as Promise<T[]>)

const actorCtx = async (slug: string, email: string, editHubs: string[]): Promise<AccountContext> => {
  const base = await ctxFor(slug, editHubs)
  // user_account is visible only to an account the person belongs to, so this
  // read has to be scoped like any other. Unscoped it returns nothing and every
  // actor silently becomes null.
  const rows = await scoped<{ id: string }>(
    base,
    sql`select id from user_account where email = ${email} limit 1`,
  )
  const actorId = rows[0]?.id
  if (!actorId) throw new Error(`${email} is not a member of ${slug}. Run pnpm db:seed.`)
  return { ...base, actorId }
}

const minutesAgo = (n: number) => Date.now() - n * 60_000

try {
  const datasaur = await ctxFor(SANDBOX.slug)
  const probe = await ctxFor(PEER.slug)

  // ---------------------------------------------------------------- schema
  section('form schema rules')

  const contactUs = await publicFormBySlug(SANDBOX.slug, 'contact-us')
  check('the seeded production forms resolve by account and slug', !!contactUs,
    contactUs ? `${contactUs.name}, ${contactUs.fields.length} fields` : 'contact-us not found')
  if (!contactUs) throw new Error('cannot continue without the contact-us form')

  const byId = await publicFormById(contactUs.formId)
  check('the same form resolves by id, and carries its account slug',
    byId?.formId === contactUs.formId && byId?.accountSlug === SANDBOX.slug,
    `accountSlug: ${byId?.accountSlug}`)

  check('a form with no email field is refused, because nothing could dedupe a contact',
    refuses(() => assertSchemaIsUsable([
      { key: 'name', type: 'text', label: 'Name', required: true },
    ])),
    'refused')

  check('two fields with the same key are refused',
    refuses(() => assertSchemaIsUsable([
      { key: 'email', type: 'email', label: 'Email', required: true },
      { key: 'email', type: 'text', label: 'Email again', required: false },
    ])), 'refused')

  check('a reserved control key cannot be used as a question',
    refuses(() => assertSchemaIsUsable([
      { key: 'email', type: 'email', label: 'Email', required: true },
      { key: 'rawr_t', type: 'text', label: 'Sneaky', required: false },
    ])), 'refused')

  check('a condition pointing at a field that does not exist is refused',
    refuses(() => assertSchemaIsUsable([
      { key: 'email', type: 'email', label: 'Email', required: true },
      { key: 'why', type: 'text', label: 'Why', required: false, visibleIf: { field: 'ghost', equals: 'x' } },
    ])), 'refused')

  check('a hand-edited schema with an unreadable field drops that field, not the form',
    readSchema([{ key: 'email', type: 'email', label: 'Email', required: true }, { key: '9bad', type: 'text' }, null]).length === 1,
    'one usable field survived')

  // ---------------------------------------------------------------- validation
  section('validation and the allowlist')

  const fields = contactUs.fields

  const injected = validateAnswers(fields, { email: 'a@b-corp.com', is_admin: 'true' })
  check('a key that is not on the form is refused rather than stored',
    injected.errors.some((e) => e.key === 'is_admin') && Object.keys(injected.answers).length === 0,
    injected.errors[0]?.message)

  const missing = validateAnswers(fields, { last_name: 'B', email: 'nope' })
  check('a missing required field and a malformed email both name themselves',
    missing.errors.length === 2,
    missing.errors.map((e) => e.message).join(' '))

  const consult = await publicFormBySlug(SANDBOX.slug, 'free-consultation')
  if (consult) {
    const hiddenRequired = validateAnswers(consult.fields, {
      first_name: 'A', email: 'a@b-corp.com', team_size: '1-5',
    })
    check('a required field hidden by a condition is not demanded',
      hiddenRequired.errors.length === 0, 'accepted without the conditional field')

    const shownRequired = validateAnswers(consult.fields, {
      first_name: 'A', email: 'a@b-corp.com', team_size: '100+',
    })
    check('the same field is required once its condition makes it visible',
      shownRequired.errors.some((e) => e.key === 'vendor'),
      shownRequired.errors[0]?.message)

    const smuggled = validateAnswers(consult.fields, {
      first_name: 'A', email: 'a@b-corp.com', team_size: '1-5', vendor: 'Smuggled',
    })
    check('an answer to a field that was never on screen is discarded, not written',
      !('vendor' in smuggled.answers), 'vendor dropped')
  }

  const badChoice = validateAnswers(fields, {
    first_name: 'A', last_name: 'B', email: 'a@b-corp.com', product_of_interest: ['Nonexistent'],
  })
  check('a choice the form does not offer is refused',
    badChoice.errors.some((e) => e.key === 'product_of_interest'),
    badChoice.errors[0]?.message)

  // ---------------------------------------------------------------- spam
  section('spam scoring')

  const clean = scoreSubmission({
    raw: {}, answers: { message: 'We label 40k images a month.' },
    email: 'dana@acme-robotics.com', fillSeconds: 47, degradedSignals: false, duplicateWithin60s: false,
  })
  check('a real person filling a form slowly scores clean', clean.state === 'clean' && clean.score === 0,
    `score ${clean.score}`)

  const slowMobile = scoreSubmission({
    raw: {}, answers: {}, email: 'a@b-corp.com', fillSeconds: 2.4,
    degradedSignals: false, duplicateWithin60s: false,
  })
  check('a slow typist just over the threshold is not penalised',
    slowMobile.state === 'clean', `2.4s -> score ${slowMobile.score}`)

  const bot = scoreSubmission({
    raw: { rawr_hp_company_url: 'http://buy.example' }, answers: {},
    email: 'bot@x-corp.com', fillSeconds: 0.3, degradedSignals: false, duplicateWithin60s: false,
  })
  check('a scripted bot trips the honeypot and the timing check together',
    bot.score >= CONFIRMED_SPAM_AT && bot.state === 'confirmed_spam',
    `score ${bot.score}: ${bot.reasons.map((r) => r.rule).join(', ')}`)

  const noJs = scoreSubmission({
    raw: {}, answers: {}, email: 'a@b-corp.com', fillSeconds: null,
    degradedSignals: true, duplicateWithin60s: false,
  })
  check('a no-JavaScript submission scores its missing signals but is not blocked',
    noJs.state === 'clean' && noJs.reasons.length === 1,
    `score ${noJs.score}, ${noJs.reasons[0]?.rule}`)

  const unreachable = applyChallenge(
    scoreSubmission({
      raw: {}, answers: {}, email: 'a@b-corp.com', fillSeconds: 0.5,
      degradedSignals: false, duplicateWithin60s: false,
    }),
    'unavailable',
  )
  check('an unreachable bot challenge fails closed to review, never to accept or reject',
    unreachable.state === 'quarantined', unreachable.reasons.at(-1)?.detail)

  const passed = applyChallenge(
    scoreSubmission({
      raw: {}, answers: {}, email: 'a@b-corp.com', fillSeconds: 0.5,
      degradedSignals: false, duplicateWithin60s: false,
    }),
    'passed',
  )
  check('passing the challenge clears a borderline submission', passed.state === 'clean',
    `was ${QUARANTINE_AT}+, now ${passed.state}`)

  check('the same answers in a different key order fingerprint identically',
    answersFingerprint({ a: '1', b: ' TWO ' }) === answersFingerprint({ b: 'two', a: '1' }),
    'order and whitespace do not decide')

  check('an IP is hashed with a rotating daily salt and never stored raw',
    hashIp('203.0.113.9', 'salt', new Date('2026-08-24')) !==
      hashIp('203.0.113.9', 'salt', new Date('2026-08-25')),
    'yesterday and today differ')

  // ---------------------------------------------------------------- attribution
  section('attribution, the SEM container')

  const attribution = readAttribution({
    rawQuery: '?utm_source=google&utm_medium=cpc&gclid=Cj0abc&li_fat_id=xyz&something_new=1',
    referrer: 'https://www.google.com/', landingPage: 'https://datasaur.ai/', pagePath: '/contact-us',
  })
  check('nothing in the query string is dropped on the way in',
    attribution.rawQuery?.includes('something_new=1') === true && attribution.rawQuery?.includes('li_fat_id') === true,
    'a parameter no code knows about is still stored verbatim')
  check('known UTM keys are lifted out beside the raw string',
    attribution.utm.source === 'google' && attribution.utm.medium === 'cpc',
    `${attribution.utm.source} / ${attribution.utm.medium}`)
  check('a paid click identifier resolves to a paid channel',
    sourceFrom(attribution).channel === 'Paid Search', sourceFrom(attribution).channel)
  check('a bare organic referrer resolves to organic search',
    sourceFrom(readAttribution({ referrer: 'https://www.google.com/' })).channel === 'Organic Search',
    'Organic Search')
  check('no referrer and no campaign is direct traffic',
    sourceFrom(readAttribution({})).channel === 'Direct Traffic', 'Direct Traffic')

  // ---------------------------------------------------------------- capture
  section('the capture path')

  const stamp = Date.now()
  const email = `verify.${stamp}@verify-corp.example`

  const first = await submitForm({
    form: contactUs,
    body: {
      first_name: 'Verify', last_name: 'Person', email,
      company: 'Verify Corp', message: 'Interested in Data Studio.',
      rawr_t: minutesAgo(1), rawr_q: '?utm_source=verify&gclid=zzz', rawr_page: '/contact-us',
    },
    attribution: { rawQuery: '?utm_source=verify&gclid=zzz', pagePath: '/contact-us' },
    ipHash: 'verify-hash', userAgent: 'verify/1.0', visitorId: null,
    degradedSignals: false, challenge: 'not-required',
  })
  check('a clean submission creates the contact and the company', first.state === 'clean' && !!first.contactId && !!first.companyId,
    `contact ${first.contactId?.slice(0, 8)}, company ${first.companyId?.slice(0, 8)}`)

  const linked = await scoped<{ n: string }>(datasaur, sql`
    select count(*) as n from activity a
      join activity_link l on l.activity_id = a.id
     where l.entity_id = ${first.contactId} and a.type = 'form_submission'`)
  check('the submission writes a form_submission activity on the contact',
    Number(linked[0]?.n) >= 1, `${linked[0]?.n} timeline entries`)

  const audit = await scoped<{ actor_kind: string }>(datasaur, sql`
    select actor_kind from audit_log where entity = 'form_submission' and entity_id = ${first.submissionId}`)
  check('the audit row reads as a stranger on the internet, not as a named integration',
    audit[0]?.actor_kind === 'public', `actor_kind ${audit[0]?.actor_kind}`)

  const second = await submitForm({
    form: contactUs,
    // Every required field is present: this exercises the upsert, not validation.
    body: {
      first_name: 'Verify', last_name: 'Person', email,
      message: 'Second note, different words.', rawr_t: minutesAgo(2),
    },
    attribution: {}, ipHash: null, userAgent: null, visitorId: null,
    degradedSignals: false, challenge: 'not-required',
  })
  check('the same address updates the same contact instead of duplicating it',
    second.contactId === first.contactId, 'one contact, two submissions')

  const preserved = await scoped<{ last_name: string | null; orig: string | null; latest: string | null }>(datasaur, sql`
    select last_name, original_source->>'channel' as orig, latest_source->>'channel' as latest
      from contact where id = ${first.contactId}`)
  check('a shorter form never blanks an answer a longer one already collected',
    preserved[0]?.last_name === 'Person', `last_name still "${preserved[0]?.last_name}"`)
  check('original source is first touch and latest source moves',
    preserved[0]?.orig === 'Paid Search' && preserved[0]?.latest === 'Direct Traffic',
    `${preserved[0]?.orig} -> ${preserved[0]?.latest}`)

  const held = await submitForm({
    form: contactUs,
    body: {
      first_name: 'Held', last_name: 'Lead', email: `held.${stamp}@verify-corp.example`,
      rawr_hp_company_url: 'http://spam.example', rawr_t: minutesAgo(1),
    },
    attribution: {}, ipHash: null, userAgent: null, visitorId: null,
    degradedSignals: false, challenge: 'unavailable',
  })
  check('a submission that trips the honeypot creates no contact at all',
    held.state !== 'clean' && held.contactId === null, `state ${held.state}`)

  const stored = await scoped<{ n: string }>(datasaur,
    sql`select count(*) as n from form_submission where id = ${held.submissionId}`)
  check('and is still stored, with its reasons, so a false positive is recoverable',
    Number(stored[0]?.n) === 1, 'nothing is silently dropped')

  // ---------------------------------------------------------------- review
  section('the review queue')

  const quarantined = await submitForm({
    form: contactUs,
    body: {
      first_name: 'Real', last_name: 'Prospect', email: `real.${stamp}@verify-corp.example`,
      message: 'We are evaluating vendors this quarter.', rawr_t: Date.now(),
    },
    attribution: {}, ipHash: null, userAgent: null, visitorId: null,
    degradedSignals: false, challenge: 'unavailable',
  })
  check('a fast but genuine submission is held rather than lost',
    quarantined.state === 'quarantined' && quarantined.contactId === null, 'held')

  // The round-robin fallback names its pool in raw SQL, so a column the schema
  // drops out from under it fails here and nowhere else: a public form is the
  // one caller, and it fails at submit time in front of a stranger.
  await saveForm(await actorCtx(SANDBOX.slug, 'admin@sandbox.test', ['contacts', 'sales', 'marketing', 'service', 'reports', 'account']), {
    name: `Rotating ${stamp}`,
    slug: `rotating-${stamp}`,
    isActive: true,
    fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
    settings: { ...contactUs.settings, assignOwner: { mode: 'round_robin', pool: [] } },
  })
  const rotated = await submitForm({
    form: (await publicFormBySlug(SANDBOX.slug, `rotating-${stamp}`))!,
    body: { email: `rotate.${stamp}@verify-corp.example`, rawr_t: minutesAgo(1) },
    attribution: {}, ipHash: null, userAgent: null, visitorId: null,
    degradedSignals: false, challenge: 'not-required',
  })
  const owned = await scoped<{ owner_id: string | null }>(datasaur, sql`
    select owner_id from contact where id = ${rotated.contactId}`)
  check('round robin with no pool falls back to the seats that can work a deal',
    !!owned[0]?.owner_id, owned[0]?.owner_id ? `owned by ${owned[0].owner_id.slice(0, 8)}` : 'nobody')

  const queue = await listSubmissions(datasaur, { state: 'quarantined' })
  check('the review queue shows it with the rule that caught it',
    queue.some((row) => row.id === quarantined.submissionId && row.spamReasons.length > 0),
    queue.find((r) => r.id === quarantined.submissionId)?.spamReasons[0]?.detail)

  const reviewer = await actorCtx(SANDBOX.slug, 'admin@sandbox.test', ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'])
  const released = await releaseSubmission(reviewer, quarantined.submissionId)
  check('releasing it creates the contact', !!released.contactId, released.contactId?.slice(0, 8))

  const timing = await scoped<{ same: boolean }>(datasaur, sql`
    select (a.occurred_at = s.at) as same
      from form_submission s
      join activity_link l on l.entity_id = s.contact_id
      join activity a on a.id = l.activity_id
     where s.id = ${quarantined.submissionId} and a.type = 'form_submission'
     order by a.occurred_at desc limit 1`)
  check('the released activity keeps the original timestamp, not today',
    timing[0]?.same === true, 'timeline reads when it actually arrived')

  check('releasing the same submission twice is refused',
    await refusesAsync(() => releaseSubmission(reviewer, quarantined.submissionId)), 'refused')

  await confirmSpam(reviewer, held.submissionId)
  const spamState = await scoped<{ spam_state: string; reviewed_by: string | null }>(datasaur,
    sql`select spam_state, reviewed_by from form_submission where id = ${held.submissionId}`)
  check('marking spam records who decided it',
    spamState[0]?.spam_state === 'confirmed_spam' && spamState[0]?.reviewed_by !== null,
    'attributed to the reviewer')

  // ------------------------------------------------- slack channel, lifecycle
  section('slack channel and lifecycle stage')

  const stages = await scoped<{ name: string }>(datasaur, sql`
    select name from lifecycle_stage order by position limit 1`)
  const stageName = stages[0]?.name ?? null

  const admin = await actorCtx(SANDBOX.slug, 'admin@sandbox.test', ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'])
  await saveForm(admin, {
    name: `Announced ${stamp}`,
    slug: `announced-${stamp}`,
    isActive: true,
    fields: [{ key: 'email', label: 'Email', type: 'email', required: true }],
    settings: {
      ...contactUs.settings,
      notifySlack: true,
      slackChannel: '#leads-verify',
      lifecycleStageOnSubmit: stageName,
      assignOwner: { mode: 'none', userId: null, pool: [] },
    },
  })
  const announced = await submitForm({
    form: (await publicFormBySlug(SANDBOX.slug, `announced-${stamp}`))!,
    body: { email: `announce.${stamp}@verify-corp.example`, rawr_t: minutesAgo(1) },
    attribution: {}, ipHash: null, userAgent: null, visitorId: null,
    degradedSignals: false, challenge: 'not-required',
  })

  // The channel a form names has to survive the trip out of the transaction, or
  // the builder's Slack channel field is a setting that changes nothing.
  check('the channel the form names rides out on the notify payload',
    announced.notify?.channel === '#leads-verify', announced.notify?.channel ?? 'nothing carried')

  const onStage = await scoped<{ name: string | null }>(datasaur, sql`
    select s.name from contact c
      left join lifecycle_stage s on s.id = c.lifecycle_stage_id
     where c.id = ${announced.contactId}`)
  check('the lifecycle stage the form names is the one the contact lands on',
    stageName !== null && onStage[0]?.name === stageName, `${onStage[0]?.name ?? 'none'} (wanted ${stageName ?? 'no stage seeded'})`)

  // Nothing is connected to Slack for a fixture tenant, and an account that never
  // connected it has no delivery to replay. Dead-lettering those filled the
  // failed-jobs screen with rows whose replay button could only fail again.
  const slackLetters = await scoped<{ n: number }>(datasaur, sql`
    select count(*)::int as n from dead_letter where job_name = 'slack.form-submission'`)
  check('an unconnected Slack leaves no dead letter behind',
    (slackLetters[0]?.n ?? 0) === 0, `${slackLetters[0]?.n ?? 0} rows`)

  // The hosted page's rate limiter reads the right end of x-forwarded-for, which
  // is web-layer code this suite cannot import. Covered by
  // apps/web/src/server/edge.test.ts, with a forged left entry.


  // ------------------------------------------------- folders, clone, counters
  section('folders, clone and the performance counters')

  // Everything in this section reads columns and a function that 0075 adds. Until
  // the orchestrator applies it these fail, and they are the checks that prove it
  // landed.
  const folderId = await saveFormFolder(admin, { name: `Campaigns ${stamp}` })
  check('a folder is created', /^[0-9a-f-]{36}$/i.test(folderId), folderId.slice(0, 8))
  check('two folders cannot share a name, whatever the case',
    await refusesAsync(() => saveFormFolder(admin, { name: `campaigns ${stamp}` })),
    'refused by name, case-insensitively')

  const announcedId = (await publicFormBySlug(SANDBOX.slug, `announced-${stamp}`))!.formId
  await moveFormToFolder(admin, { formId: announcedId, folderId })
  const filed = (await listFormFolders(admin)).find((entry) => entry.id === folderId)
  check('the folder counts the form filed into it', filed?.forms === 1, `${filed?.forms ?? 0} forms`)

  await deleteFormFolder(admin, folderId)
  const orphaned = (await listForms(admin)).find((row) => row.id === announcedId)
  check('deleting a folder empties it and leaves the form alone',
    orphaned !== undefined && orphaned.folderId === null, 'form kept, folder reference cleared')

  const copyId = await cloneForm(admin, announcedId)
  const copy = await getForm(admin, copyId)
  const original = await getForm(admin, announcedId)
  check('a clone copies the questions and the settings',
    copy !== null && original !== null &&
      JSON.stringify(copy.fields) === JSON.stringify(original.fields) &&
      copy.settings.slackChannel === original.settings.slackChannel,
    `${copy?.fields.length ?? 0} fields copied`)
  check('a clone takes a free address and starts turned off',
    copy !== null && copy.slug !== original?.slug && copy.isActive === false,
    `${copy?.slug ?? 'no slug'}, published ${copy?.isActive ?? 'unknown'}`)

  await countFormView({ accountId: datasaur.accountId, formId: announcedId, pagePath: '/pricing', kinds: ['view', 'render'] })
  await countFormView({ accountId: datasaur.accountId, formId: announcedId, pagePath: '/pricing', kinds: ['render'] })
  await countFormView({ accountId: datasaur.accountId, formId: announcedId, pagePath: '/pricing', kinds: ['interaction'] })
  await countFormView({ accountId: datasaur.accountId, formId: announcedId, pagePath: '/contact', kinds: ['render'] })

  const counted = await scoped<{ rows: number; views: number; renders: number; interactions: number }>(datasaur, sql`
    select count(*)::int as rows,
           coalesce(sum(views), 0)::int as views,
           coalesce(sum(renders), 0)::int as renders,
           coalesce(sum(interactions), 0)::int as interactions
      from form_view where form_id = ${announcedId}`)
  check('four beacons over two paths are two rows, not four',
    counted[0]?.rows === 2, `${counted[0]?.rows ?? 0} rows`)
  check('the three counters add up rather than overwrite each other',
    counted[0]?.views === 1 && counted[0]?.renders === 3 && counted[0]?.interactions === 1,
    `${counted[0]?.views} views, ${counted[0]?.renders} renders, ${counted[0]?.interactions} interactions`)

  const today = new Date().toISOString().slice(0, 10)
  const performance = await formPerformance(admin, { formId: announcedId, from: today, to: today })
  check('the performance tab counts the views the beacons reported',
    performance?.totals.renders === 3, `${performance?.totals.renders ?? 0} renders`)
  check('"appears on" is the distinct paths the form rendered on',
    performance?.appearsOn.length === 2, (performance?.appearsOn ?? []).join(', ') || 'none')
  check('the submission this form already took is counted, and its contact was new',
    (performance?.totals.submissions ?? 0) >= 1 && (performance?.contactType.created ?? 0) >= 1,
    `${performance?.totals.submissions ?? 0} submissions, ${performance?.contactType.created ?? 0} new contacts`)
  check('a form nobody else can see is refused a performance read',
    (await formPerformance(probe, { formId: announcedId, from: today, to: today })) === null,
    'the other tenant sees no such form')

  // ------------------------------------------------- conditional properties
  section('conditional property logic on the public form')

  const conditioned = await publicFormBySlug(SANDBOX.slug, 'contact-us')
  check('the public resolver ships the rules alongside the schema',
    conditioned !== null && typeof conditioned.rules === 'object',
    `${Object.keys(conditioned?.rules ?? {}).length} rules on this form`)

  const ruled: FormField[] = [
    { key: 'email', label: 'Email', type: 'email', required: true, mapsTo: 'contact.email' },
    { key: 'industry', label: 'Industry', type: 'text', required: false, mapsTo: 'contact.industry' },
    { key: 'seats', label: 'Seats', type: 'number', required: true, mapsTo: 'contact.seats' },
  ]
  const seatsRule = {
    'contact.seats': { conjunction: 'and' as const, conditions: [{ field: 'industry', operator: 'is' as const, value: 'SaaS' }] },
  }
  const notAsked = validateAnswers(ruled, { email: 'a@verify-corp.example', industry: 'Retail' }, seatsRule)
  check('a required question the property rule hides is not demanded',
    notAsked.errors.length === 0, `${notAsked.errors.length} errors`)
  const asked = validateAnswers(ruled, { email: 'a@verify-corp.example', industry: 'SaaS' }, seatsRule)
  check('the same question is required once the rule matches',
    asked.errors[0]?.key === 'seats', asked.errors[0]?.message ?? 'nothing refused')
  const forced = validateAnswers(ruled, { email: 'a@verify-corp.example', industry: 'Retail', seats: '40' }, seatsRule)
  check('an answer posted past a hidden question is discarded, not written',
    forced.answers.seats === undefined, JSON.stringify(forced.answers))

  // ---------------------------------------------------------------- roles
  section('roles and tenancy')

  const viewer = await actorCtx(SANDBOX.slug, 'viewer@sandbox.test', [])
  check('a viewer can read the queue', (await listSubmissions(viewer, { state: 'clean' })).length >= 0,
    'read allowed')
  check('a viewer cannot release a held lead',
    await refusesAsync(() => releaseSubmission(viewer, quarantined.submissionId)), 'refused in the data access layer')
  check('a viewer cannot change a form',
    await refusesAsync(() => saveForm(viewer, {
      name: 'Nope', slug: 'nope', isActive: true, settings: contactUs.settings,
      fields: [{ key: 'email', type: 'email', label: 'Email', required: true }],
    })), 'refused')

  const sales = await actorCtx(SANDBOX.slug, 'sales@sandbox.test', ['contacts', 'sales'])
  check('sales can act on the review queue but cannot rebuild a form',
    await refusesAsync(() => saveForm(sales, {
      name: 'Nope', slug: 'nope-2', isActive: true, settings: contactUs.settings,
      fields: [{ key: 'email', type: 'email', label: 'Email', required: true }],
    })), 'form editing is admin and marketing only')

  const edge = publicEdgeContext(datasaur.accountId)
  check(
    'the public edge acts with marketing’s ceiling, not an admin’s',
    edge.editHubs.includes('marketing') && !edge.editHubs.includes('account') && edge.actorKind === 'public',
    `${edge.actorKind} / ${edge.editHubs.join()}`,
  )

  const probeForms = await listForms(probe)
  const datasaurForms = await listForms(datasaur)
  check('each tenant sees only its own forms',
    probeForms.length > 0 && datasaurForms.length > 0 &&
      !probeForms.some((f) => datasaurForms.some((d) => d.id === f.id)),
    `probe ${probeForms.length}, datasaur ${datasaurForms.length}, no overlap`)

  const probeQueue = await listSubmissions(probe, { state: 'clean' })
  check('the probe tenant sees none of Datasaur’s submissions',
    !probeQueue.some((row) => row.id === first.submissionId), `probe sees ${probeQueue.length}`)

  check('a reviewer in one tenant cannot release another tenant’s submission',
    await refusesAsync(() => releaseSubmission(probe, quarantined.submissionId)),
    'refused: the row is invisible under the other tenant’s scope')

  // ---------------------------------------------------------------- consent
  section('consent')

  check('the attribution control keys are reserved so they never look like answers',
    ['rawr_q', 'rawr_ref', 'rawr_landing', 'rawr_page', 'rawr_vid'].every((k) => FORM_RESERVED_KEYS.has(k)),
    'five control keys reserved')

  const withControls = validateAnswers(fields, {
    first_name: 'A', last_name: 'B', email: 'a@b-corp.com',
    rawr_q: '?utm_source=x', rawr_vid: 'visitor-1', rawr_t: String(Date.now()),
  })
  check('a submission carrying its attribution is not rejected as unknown fields',
    withControls.errors.length === 0, 'control keys skipped by the allowlist')
} catch (cause) {
  failures++
  console.error('\nthe suite could not finish:', cause instanceof Error ? cause.message : cause)
} finally {
  console.log(
    failures === 0
      ? `\nall ${checks} form checks passed.`
      : `\n${failures} of ${checks} form checks FAILED.`,
  )
  // Given back before exiting, so the next suite in `pnpm verify` does not start
  // against a pooler this one is still holding connections on.
  await closeAppPool()
  await cleanup()
  process.exit(failures === 0 ? 0 : 1)
}

function refuses(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

async function refusesAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}
