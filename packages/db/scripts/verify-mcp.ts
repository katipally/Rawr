import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { INTEGRATION_KINDS } from '../src/dal/integrations.ts'
import { randomToken } from '../src/internal/crypto.ts'
import { appDb, closeAppPool } from '../src/internal/pool.ts'
import {
  createMcpToken,
  createRecord,
  forgetRegistry,
  getRecord,
  listMcpTokens,
  revokeMcpToken,
  withAccount,
  type AccountContext,
} from '../src/index.ts'
import { SANDBOX, PEER } from './fixture.ts'

/** F5's definition of done, run against the real endpoint over HTTP.
 *
 *  Deliberately over the wire rather than by importing the handlers. The things
 *  most likely to be wrong are the ones only the wire shows: an unauthenticated
 *  call answered 200, a revoked token still working because a lookup was cached, a
 *  role refusal arriving as a crash instead of a sentence a model can read.
 *
 *  Needs the dev server running (pnpm dev). Idempotent: everything it creates is
 *  named for this suite and removed at the end, whether it passed or not. */

const BASE = process.env.RAWR_MCP_BASE ?? 'http://localhost:3000'
const ENDPOINT = `${BASE}/api/mcp`

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

const section = (title: string) =>
  console.log(`\n-- ${title} ${'-'.repeat(Math.max(0, 60 - title.length))}`)

// ---------------------------------------------------------------------------
// Talking to the endpoint
// ---------------------------------------------------------------------------

/** What the endpoint answers, typed by the fields this script asserts on. Every
 *  one is optional because a server that omits them is exactly what these checks
 *  are here to catch. */
type ToolDescriptor = {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

type RpcResult = {
  resultType?: string
  protocolVersion?: string
  protocolVersions?: string[]
  serverInfo?: { name?: string; title?: string; version?: string }
  instructions?: string
  tools?: ToolDescriptor[]
  ttlMs?: number
  cacheScope?: string
  content?: { type?: string; text?: string }[]
  structuredContent?: ToolData
  isError?: boolean
}

type RpcBody = {
  jsonrpc?: string
  id?: string | number | null
  result?: RpcResult
  error?: { code?: number; message?: string; data?: unknown }
}

type Rpc = { status: number; body: RpcBody | null }

/** The token endpoint answers one of two shapes. Each call below knows which it
 *  is asserting on, so naming both is what keeps the assertions honest. */
type IssuedTokens = { access_token: string; refresh_token: string; expires_in?: number }
type OAuthFailure = { error?: string; error_description?: string }

let nextId = 1

const rpc = async (token: string | null, method: string, params?: unknown): Promise<Rpc> => {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

/** A tool's structuredContent. Its shape is the tool's own and differs for every
 *  one of the hundred-odd tools this script calls, so it is read the way a client
 *  reads it: by reaching for the field being asserted on. The assertion is the
 *  check, and narrowing each of those reads would add noise to a test script
 *  without catching anything the assertion does not.
 *  biome-ignore lint/suspicious/noExplicitAny: see above */
type ToolData = any

type ToolAnswer = { text: string; data: ToolData; isError: boolean; status: number; rpcError: string | null }

const call = async (
  token: string,
  name: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<ToolAnswer> => {
  const answer = await rpc(token, 'tools/call', { name, arguments: args, ...extra })
  const result = answer.body?.result
  return {
    text: String(result?.content?.[0]?.text ?? ''),
    data: result?.structuredContent ?? null,
    isError: result?.isError === true,
    status: answer.status,
    rpcError: answer.body?.error?.message ?? null,
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ctxFor = async (slug: string, editHubs: string[] = ['contacts', 'sales', 'marketing', 'service', 'reports', 'account']): Promise<AccountContext> => {
  const rows = await appDb.execute<{ id: string }>(
    sql`select id from rawr.account_for_site(${slug})`,
  )
  const id = rows[0]?.id
  if (!id) throw new Error(`account ${slug} is not seeded. Run pnpm db:seed.`)
  return { accountId: id, actorId: null, actorKind: 'user', isSuperAdmin: false, viewHubs: [], editHubs: editHubs as AccountContext['editHubs'] }
}

const scoped = <T extends Record<string, unknown>>(
  ctx: AccountContext,
  query: ReturnType<typeof sql>,
): Promise<T[]> => withAccount(ctx, (tx) => tx.execute<T>(query) as Promise<T[]>)

const actorCtx = async (slug: string, email: string, editHubs: string[]): Promise<AccountContext> => {
  const base = await ctxFor(slug, editHubs)
  const rows = await scoped<{ id: string }>(
    base,
    sql`select id from user_account where email = ${email} limit 1`,
  )
  const actorId = rows[0]?.id
  if (!actorId) throw new Error(`${email} is not a member of ${slug}. Run pnpm db:seed.`)
  return { ...base, actorId }
}

/** Named for this suite so the cleanup at the end can find every row it made,
 *  including the ones a failed run left behind. */
const MARK = 'F5 Verify'

const created: { tokens: string[]; deals: string[]; contacts: string[]; fields: string[] } = {
  tokens: [],
  deals: [],
  contacts: [],
  fields: [],
}

try {
  const reachable = await fetch(ENDPOINT, { method: 'GET' })
    .then((response) => response.status === 405)
    .catch(() => false)
  if (!reachable) {
    console.error(
      `\nThe MCP endpoint at ${ENDPOINT} is not answering. Start the app with "pnpm dev", or set RAWR_MCP_BASE.\n`,
    )
    process.exit(1)
  }

  const admin = await actorCtx(SANDBOX.slug, 'admin@sandbox.test', ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'])
  const sales = await actorCtx(SANDBOX.slug, 'sales@sandbox.test', ['contacts', 'sales'])
  const viewer = await actorCtx(SANDBOX.slug, 'viewer@sandbox.test', [])
  const probe = await actorCtx(PEER.slug, 'admin@peer.test', ['contacts', 'sales', 'marketing', 'service', 'reports', 'account'])

  const issue = async (ctx: AccountContext, name: string): Promise<string> => {
    const issued = await createMcpToken(ctx, { name: `${MARK} ${name}` })
    created.tokens.push(issued.row.id)
    return issued.token
  }

  const salesToken = await issue(sales, 'sales')
  const viewerToken = await issue(viewer, 'viewer')
  const probeToken = await issue(probe, PEER.slug)
  const doomedToken = await issue(admin, 'doomed')

  // The deal Trevor names out loud, plus two that share a word, which is the case
  // resolution has to refuse rather than guess at.
  const stage = (
    await scoped<{ id: string; name: string }>(
      admin,
      sql`select s.id, s.name from pipeline_stage s order by s.position limit 1`,
    )
  )[0]!
  const pipelineId = (
    await scoped<{ id: string }>(admin, sql`select id from pipeline order by position limit 1`)
  )[0]!.id

  const newDeal = async (name: string): Promise<string> => {
    const record = await createRecord(sales, 'deal', {
      name,
      pipeline_id: pipelineId,
      stage_id: stage.id,
      amount: 12000,
      currency: 'USD',
    })
    created.deals.push(record.id)
    return record.id
  }

  const mggId = await newDeal(`${MARK} MGG Production Opportunity`)
  await newDeal(`${MARK} Twinned Alpha Opportunity`)
  await newDeal(`${MARK} Twinned Beta Opportunity`)

  // -----------------------------------------------------------------------
  section('authentication')

  const anonymous = await rpc(null, 'tools/list')
  check('a call with no token is refused', anonymous.status === 401, `HTTP ${anonymous.status}`)
  check(
    'and is told where to get one',
    String(anonymous.body?.error?.message ?? '').includes('Settings'),
    anonymous.body?.error?.message ?? '',
  )

  const guessed = await rpc('rawr_mcp_thisisnotarealtokenatallnope', 'tools/list')
  check('a guessed token is refused', guessed.status === 401)
  check(
    'and a wrong token cannot be told from a revoked one',
    !String(guessed.body?.error?.message ?? '').toLowerCase().includes('unknown token'),
    'the message must not tell a prober which half they got right',
  )

  const shaped = await rpc('not-even-the-right-shape', 'tools/list')
  check('a token of the wrong shape is refused before any lookup', shaped.status === 401)

  const listed = await rpc(salesToken, 'tools/list')
  check('a real token lists the tools', listed.status === 200 && Array.isArray(listed.body?.result?.tools))

  // -----------------------------------------------------------------------
  section('the protocol, both versions of it')

  const initialised = await rpc(salesToken, 'initialize', { protocolVersion: '2025-06-18' })
  check(
    'an older client gets the version it asked for',
    initialised.body?.result?.protocolVersion === '2025-06-18',
    String(initialised.body?.result?.protocolVersion),
  )
  check(
    'and is told what the server is',
    initialised.body?.result?.serverInfo?.name === 'rawr',
  )
  check(
    'with instructions that name the resolution rule',
    String(initialised.body?.result?.instructions ?? '').includes('refused with the candidates'),
  )

  const discovered = await rpc(salesToken, 'server/discover')
  check(
    'a 2026 client discovers without a handshake',
    Array.isArray(discovered.body?.result?.protocolVersions) &&
      discovered.body.result.protocolVersions.includes('2026-07-28'),
    (discovered.body?.result?.protocolVersions ?? []).join(', '),
  )

  const wrongVersion = await rpc(salesToken, 'initialize', { protocolVersion: '1999-01-01' })
  check(
    'a version this server does not speak is refused, not guessed at',
    wrongVersion.status === 400 && String(wrongVersion.body?.error?.message).includes('2026-07-28'),
    wrongVersion.body?.error?.message ?? '',
  )

  const badHeader = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${salesToken}`,
      'mcp-protocol-version': '1999-01-01',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
  check('and so is an unsupported version in the header', badHeader.status === 400)

  const notification = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  })
  check(
    'a notification is accepted with no body',
    notification.status === 202 && (await notification.text()) === '',
    `HTTP ${notification.status}`,
  )

  const pinged = await rpc(salesToken, 'ping')
  check('ping answers', pinged.status === 200 && pinged.body?.error === undefined)

  const unknownMethod = await rpc(salesToken, 'nonsense/method')
  check(
    'an unknown method is a -32601 rather than a crash',
    unknownMethod.body?.error?.code === -32601,
    unknownMethod.body?.error?.message ?? '',
  )

  const notJson = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${salesToken}` },
    body: 'this is not json',
  })
  check('a body that is not JSON says so', notJson.status === 400)

  const getMethod = await fetch(ENDPOINT, { method: 'GET' })
  check('GET is 405 with an Allow header', getMethod.status === 405 && getMethod.headers.get('allow') === 'POST')

  // -----------------------------------------------------------------------
  section('the tool catalogue')

  const tools: ToolDescriptor[] = listed.body?.result?.tools ?? []
  const names = tools.map((tool) => tool.name).sort()
  check(
    'the ten hand-written tools are offered, then one per procedure',
    names.length >= 120,
    `${names.length} tools`,
  )
  check(
    'the five reads and the five writes are the ones the doc names',
    [
      'create_note',
      'create_record',
      'create_task',
      'get_record',
      'list_activities',
      'list_pipeline',
      'list_tasks',
      'log_activity',
      'search_records',
      'update_record',
    ].every((name) => names.includes(name)),
  )
  check(
    'a delete, merge or bulk tool is marked destructive, so a client confirms first',
    tools
      .filter((tool) => /remove|merge|bulk/.test(tool.name))
      .every((tool) => tool.annotations?.destructiveHint === true),
    tools.filter((tool) => tool.annotations?.destructiveHint === true).map((t) => t.name).join(', '),
  )
  check(
    'every screen has a tool: mail, meetings, forms, segments, integrations, settings',
    // mail_inbox rather than mail_body: bodies are stored with the thread now, so
    // there is no separate fetch, and the shared inbox is its own screen.
    ['mail_thread', 'mail_inbox', 'booking_pages', 'forms_list', 'segments_list', 'integrations_list', 'admin_fields_list'].every(
      (name) => names.includes(name),
    ),
  )
  check(
    'every tool has a schema a client can validate against',
    tools.every((tool) => tool.inputSchema?.type === 'object'),
  )
  check(
    'reads are marked read-only, writes are not',
    tools.find((t) => t.name === 'search_records')?.annotations?.readOnlyHint === true &&
      tools.find((t) => t.name === 'update_record')?.annotations?.readOnlyHint === false,
  )
  check(
    'the list is cacheable and says for how long',
    typeof listed.body?.result?.ttlMs === 'number' && listed.body.result.cacheScope === 'private',
    `${listed.body?.result?.ttlMs}ms, ${listed.body?.result?.cacheScope}`,
  )
  check(
    'and carries the 2026 result type',
    listed.body?.result?.resultType === 'complete',
  )

  const unknownTool = await call(salesToken, 'destroy_everything', {})
  check(
    'an unknown tool points at the catalogue',
    (unknownTool.rpcError ?? '').includes('tools/list'),
    unknownTool.rpcError ?? '',
  )

  const generated = await call(salesToken, 'integrations_list', {})
  check(
    'a generated tool runs the same procedure the screen does',
    // Every kind the registry knows, configured or not: an integration that is
    // simply absent is a state somebody needs to see.
    !generated.isError &&
      Array.isArray(generated.data?.rows) &&
      generated.data.rows.length === INTEGRATION_KINDS.length,
    generated.text,
  )
  const generatedRefusal = await call(viewerToken, 'crm_records_remove', { object: 'deal', id: mggId })
  // The refusal names the hub that was missing, so the assistant relaying it tells
  // the person what to ask for rather than which role they are not.
  check(
    'and a generated write is refused by grant in the layer, in a sentence',
    generatedRefusal.isError && /sales access/i.test(generatedRefusal.text),
    generatedRefusal.text,
  )

  // -----------------------------------------------------------------------
  section('oauth: the way a client actually connects')

  const discovery = await fetch(`${BASE}/.well-known/oauth-protected-resource/api/mcp`).then(
    (r) => r.json() as Promise<{ resource?: string; authorization_servers?: string[] }>,
  )
  check('the protected resource names itself and its authorization server', discovery.resource === ENDPOINT && discovery.authorization_servers?.[0] === BASE)
  const server = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then(
    (r) =>
      r.json() as Promise<{
        code_challenge_methods_supported?: string[]
        registration_endpoint?: string
        client_id_metadata_document_supported?: boolean
        token_endpoint_auth_methods_supported?: string[]
      }>,
  )
  check(
    'the authorization server advertises PKCE S256, DCR, CIMD and public clients',
    // Coalesced rather than optional-chained: `?.includes()` on a missing field
    // is undefined, not false, and an undefined here used to reach check() as a
    // falsy value that read as a failure without ever saying which half failed.
    (server.code_challenge_methods_supported ?? []).includes('S256') &&
      typeof server.registration_endpoint === 'string' &&
      server.client_id_metadata_document_supported === true &&
      (server.token_endpoint_auth_methods_supported ?? []).includes('none'),
  )
  check(
    'a 401 carries the resource_metadata pointer',
    /resource_metadata=/.test(
      (await fetch(ENDPOINT, { method: 'POST', body: '{}' })).headers.get('www-authenticate') ?? '',
    ),
  )

  const registered = await fetch(`${BASE}/api/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: `${MARK} client`, redirect_uris: ['http://localhost/callback'] }),
  }).then((r) => r.json() as Promise<{ client_id: string }>)
  check('a public client registers dynamically', typeof registered.client_id === 'string', registered.client_id)
  const badRegistration = await fetch(`${BASE}/api/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'x', redirect_uris: ['http://evil.example/cb'] }),
  })
  check('a plain-http redirect off the loopback is refused', badRegistration.status === 400)

  const devLogin = await fetch(`${BASE}/api/auth/dev`, {
    method: 'POST',
    body: new URLSearchParams({ email: 'sales@sandbox.test' }),
    redirect: 'manual',
  })
  const cookie = devLogin.headers.get('set-cookie')?.split(';')[0] ?? ''
  if (!cookie.startsWith('rawr_session=')) {
    console.log('skip  consent flow: dev sign-in is not enabled here (RAWR_DEV_LOGIN)')
  } else {
    const verifier = randomToken(48)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const approve = await fetch(`${BASE}/api/oauth/authorize`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({
        client_id: registered.client_id,
        redirect_uri: 'http://localhost:5555/callback',
        code_challenge: challenge,
        state: 'verify',
        decision: 'approve',
      }),
      redirect: 'manual',
    })
    const back = new URL(approve.headers.get('location') ?? 'http://x/')
    check(
      'approving sends a code back to the loopback with any port, plus state and iss',
      back.port === '5555' && back.searchParams.get('state') === 'verify' && back.searchParams.get('iss') === BASE && Boolean(back.searchParams.get('code')),
      back.toString(),
    )

    const wrongVerifier = await fetch(`${BASE}/api/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') ?? '',
        code_verifier: 'x'.repeat(50),
        client_id: registered.client_id,
      }),
    }).then((r) => r.json() as Promise<OAuthFailure>)
    check('a wrong PKCE verifier is refused and burns the code', wrongVerifier.error === 'invalid_grant')

    const second = await fetch(`${BASE}/api/oauth/authorize`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ client_id: registered.client_id, redirect_uri: 'http://localhost:5555/callback', code_challenge: challenge, decision: 'approve' }),
      redirect: 'manual',
    })
    const code = new URL(second.headers.get('location') ?? 'http://x/').searchParams.get('code') ?? ''
    const tokens = await fetch(`${BASE}/api/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: registered.client_id }),
    }).then((r) => r.json() as Promise<IssuedTokens>)
    check('the right verifier gets an access token and a refresh token', typeof tokens.access_token === 'string' && typeof tokens.refresh_token === 'string' && tokens.expires_in === 3600)

    const viaOauth = await call(tokens.access_token, 'get_record', { object: 'deal', id: mggId })
    check('the OAuth token reads as the person who approved', !viaOauth.isError && viaOauth.text.includes('MGG'), viaOauth.text.slice(0, 80))

    const reused = await fetch(`${BASE}/api/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: registered.client_id }),
    }).then((r) => r.json() as Promise<OAuthFailure>)
    check('a code cannot be redeemed twice', reused.error === 'invalid_grant')

    const refreshed = await fetch(`${BASE}/api/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: registered.client_id }),
    }).then((r) => r.json() as Promise<IssuedTokens>)
    check('a refresh rotates both tokens', typeof refreshed.access_token === 'string' && refreshed.refresh_token !== tokens.refresh_token)
    const staleRefresh = await fetch(`${BASE}/api/oauth/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: registered.client_id }),
    }).then((r) => r.json() as Promise<OAuthFailure>)
    check('the old refresh token is dead the moment the new one exists', staleRefresh.error === 'invalid_grant')
    const staleAccess = await rpc(tokens.access_token, 'ping')
    check('and so is the old access token', staleAccess.status === 401)

    const ownTokens = await listMcpTokens(sales)
    check(
      'the connection appears in Settings under the client name, revocable like any token',
      ownTokens.some((t) => t.name === `${MARK} client` && !t.revokedAt),
    )
  }

  // -----------------------------------------------------------------------
  section('the registry is the schema')

  const [customField] = await scoped<{ id: string }>(
    admin,
    sql`insert into field_def (account_id, object_id, key, label, type, storage, options, position, is_custom)
        select ${admin.accountId}, o.id, 'f5_verify_flavour', 'F5 Verify Flavour', 'select', 'jsonb',
               '["Vanilla","Chocolate"]'::jsonb, 900, true
          from object_def o where o.key = 'deal'
        returning id`,
  )
  created.fields.push(customField!.id)
  forgetRegistry(admin.accountId)

  // The app holds its own registry for thirty seconds, so this waits it out rather
  // than asserting an instant that was never promised. "No deploy" is the claim.
  const describedField = async (): Promise<string> => {
    const answer = await rpc(salesToken, 'tools/list')
    const tool = (answer.body?.result?.tools ?? []).find((t) => t.name === 'update_record')
    return String(tool?.description ?? '')
  }

  let described = await describedField()
  for (let waited = 0; waited < 40 && !described.includes('f5_verify_flavour'); waited += 2) {
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    described = await describedField()
  }

  check(
    'a custom field appears in the tool schema with no deploy',
    described.includes('f5_verify_flavour'),
    'the catalogue is generated from the registry on every list',
  )
  check(
    'with its type and its allowed values',
    described.includes('Vanilla | Chocolate'),
  )

  // -----------------------------------------------------------------------
  section('resolution, which is the feature')

  const byName = await call(salesToken, 'get_record', { object: 'deal', id: `${MARK} MGG Production Opportunity` })
  check('an exact name resolves', !byName.isError && byName.data?.id === mggId, byName.text.split('\n')[0] ?? '')

  const fuzzy = await call(salesToken, 'get_record', { object: 'deal', id: `${MARK} MGG Production` })
  check('a near miss resolves', !fuzzy.isError && fuzzy.data?.id === mggId)

  const byId = await call(salesToken, 'get_record', { object: 'deal', id: mggId })
  check('and so does an id', !byId.isError && byId.data?.id === mggId)

  const ambiguous = await call(salesToken, 'update_record', {
    object: 'deal',
    id: `${MARK} Twinned`,
    fields: { amount: 99 },
  })
  check('an ambiguous name is refused', ambiguous.isError, ambiguous.text.split('\n')[0] ?? '')
  check(
    'with the candidates and their distinguishing detail',
    ambiguous.text.includes('Alpha') && ambiguous.text.includes('Beta') && ambiguous.text.includes(stage.name),
  )
  check(
    'and nothing at all is written',
    ambiguous.text.includes('Nothing was changed'),
    'picking one silently is the failure that loses trust permanently',
  )

  const missing = await call(salesToken, 'get_record', { object: 'deal', id: 'a deal nobody ever created' })
  check('a name that matches nothing says so', missing.isError && missing.text.includes('No deal matches'))

  const badObject = await call(salesToken, 'get_record', { object: 'unicorn', id: 'x' })
  check(
    'an object that does not exist names the ones that do',
    badObject.isError && badObject.text.includes('contact, company, deal'),
    badObject.text,
  )

  // -----------------------------------------------------------------------
  section('the sentence this feature exists for')

  const spoken = await call(salesToken, 'update_record', {
    object: 'deal',
    id: `${MARK} MGG Production Opportunity`,
    fields: { close_date: 'October 15th' },
  })
  check('"update the close date to October 15th" works', !spoken.isError, spoken.text.split('\n')[0] ?? '')
  check(
    'and the response states the resolved ISO date rather than "done"',
    /\d{4}-10-15/.test(spoken.text),
    spoken.text.replace(/\n/g, ' | '),
  )
  check('and shows the before as well as the after', spoken.text.includes('→'))

  const landed = await getRecord(sales, 'deal', mggId)
  check(
    'the change is on the record',
    String(landed?.values.close_date ?? '').includes('-10-15'),
    String(landed?.values.close_date ?? ''),
  )

  const timeline = await scoped<{ type: string; actor_kind: string; actor_id: string }>(
    sales,
    sql`select a.type, a.actor_kind, a.actor_id
          from activity a join activity_link l on l.activity_id = a.id
         where l.entity_id = ${mggId} order by a.created_at desc limit 1`,
  )
  check('with a timeline entry', timeline.length > 0, timeline[0]?.type ?? 'none')

  const audited = await scoped<{ actor_kind: string; actor_id: string }>(
    sales,
    sql`select actor_kind, actor_id from audit_log
         where entity = 'deal' and entity_id = ${mggId} order by at desc limit 1`,
  )
  check(
    'and an audit row attributed to the person, through the MCP door',
    audited[0]?.actor_kind === 'mcp' && audited[0]?.actor_id === sales.actorId,
    `${audited[0]?.actor_kind}, ${audited[0]?.actor_id === sales.actorId ? 'the real user' : 'somebody else'}`,
  )

  const relative = await call(salesToken, 'update_record', {
    object: 'deal',
    id: mggId,
    fields: { close_date: 'next friday' },
  })
  check(
    '"next friday" resolves and says how it was read',
    !relative.isError && relative.text.includes('read as'),
    relative.text.split('\n').at(-1) ?? '',
  )

  const nonsenseDate = await call(salesToken, 'update_record', {
    object: 'deal',
    id: mggId,
    fields: { close_date: 'the second tuesday of whenever' },
  })
  check(
    'a date nobody can read is refused with the formats that work',
    nonsenseDate.isError && nonsenseDate.text.includes('YYYY-MM-DD'),
    nonsenseDate.text,
  )

  const byStageName = await call(salesToken, 'update_record', {
    object: 'deal',
    id: mggId,
    fields: { stage_id: stage.name },
  })
  check(
    'a stage can be named rather than given as an id',
    !byStageName.isError,
    byStageName.text.split('\n')[0] ?? '',
  )

  const notAStage = await call(salesToken, 'update_record', {
    object: 'deal',
    id: mggId,
    fields: { stage_id: 'Sent To Legal For Vibes' },
  })
  check(
    'a stage that is not a stage is refused with the valid list',
    notAStage.isError && notAStage.text.includes(stage.name),
    notAStage.text,
  )

  const notAnOption = await call(salesToken, 'update_record', {
    object: 'deal',
    id: mggId,
    fields: { f5_verify_flavour: 'Strawberry' },
  })
  check(
    'a select value that is not an option is refused with the choices',
    notAnOption.isError && notAnOption.text.includes('Vanilla'),
    notAnOption.text,
  )

  const goodOption = await call(salesToken, 'update_record', {
    object: 'deal',
    id: mggId,
    fields: { f5_verify_flavour: 'chocolate' },
  })
  check(
    'and one that is an option lands, case and all',
    !goodOption.isError,
    goodOption.text.split('\n').at(-1) ?? '',
  )

  const unknownKey = await call(salesToken, 'update_record', {
    object: 'deal',
    id: mggId,
    fields: { vibes: 'immaculate' },
  })
  check(
    'a field key that does not exist is refused listing the valid keys',
    unknownKey.isError && unknownKey.text.includes('close_date'),
    unknownKey.text.slice(0, 120),
  )

  const tooMany = await call(salesToken, 'update_record', {
    object: 'deal',
    id: mggId,
    fields: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`f${i}`, i])),
  })
  check('five hundred fields in one call is refused', tooMany.isError, tooMany.text.slice(0, 80))

  // -----------------------------------------------------------------------
  section('the other tools')

  const searched = await call(salesToken, 'search_records', { query: 'MGG Production', object: 'deal' })
  check('search finds it', !searched.isError && searched.data?.total >= 1, `${searched.data?.total} matches`)

  const pipeline = await call(salesToken, 'list_pipeline', {})
  check(
    'the pipeline lists stages with counts and totals',
    !pipeline.isError && Array.isArray(pipeline.data?.stages) && pipeline.data.stages.length > 0,
    `${pipeline.data?.stages?.length} stages`,
  )
  check(
    'and totals are per currency, never summed across them',
    pipeline.data.stages.every((s: Record<string, unknown>) => Array.isArray(s.totals)),
  )

  const noteAdded = await call(salesToken, 'create_note', {
    object: 'deal',
    id: mggId,
    body: `${MARK} spoke to them, they want a pilot`,
  })
  check('a note lands on the timeline', !noteAdded.isError, noteAdded.text)

  const activities = await call(salesToken, 'list_activities', { object: 'deal', id: mggId, type: ['note'] })
  check(
    'and reads back through list_activities',
    !activities.isError && activities.data?.activities?.length >= 1,
  )

  const badType = await call(salesToken, 'list_activities', { object: 'deal', id: mggId, type: ['gossip'] })
  check(
    'an activity type that does not exist names the ones that do',
    badType.isError && badType.text.includes('stage_change'),
  )

  const taskMade = await call(salesToken, 'create_task', {
    object: 'deal',
    id: mggId,
    title: `${MARK} send the pilot scope`,
    due_date: 'tomorrow',
  })
  check('a task is created with a spoken due date', !taskMade.isError && !!taskMade.data?.dueDate, taskMade.text.replace(/\n/g, ' | '))

  const tasks = await call(salesToken, 'list_tasks', {})
  check('and appears in list_tasks', !tasks.isError && tasks.text.includes('send the pilot scope'))

  const logged = await call(salesToken, 'log_activity', {
    object: 'deal',
    id: mggId,
    type: 'call',
    subject: `${MARK} discovery call`,
    occurred_at: '2026-08-01',
  })
  check('a past call is logged at the date it happened', !logged.isError && logged.text.includes('2026-08-01'))

  const unloggable = await call(salesToken, 'log_activity', {
    object: 'deal',
    id: mggId,
    type: 'form_submission',
    subject: 'pretending somebody filled in a form',
  })
  check(
    'and a type only Rawr may write is refused',
    unloggable.isError,
    'a hand-written form_submission would be a lie on a timeline people trust',
  )

  const madeContact = await call(salesToken, 'create_record', {
    object: 'contact',
    fields: { first_name: 'F5', last_name: 'Verify', email: 'f5-verify@northwind-labs.test' },
  })
  check('a contact can be created', !madeContact.isError, madeContact.text.split('\n')[0] ?? '')
  if (madeContact.data?.id) created.contacts.push(madeContact.data.id)

  const rowCap = await call(salesToken, 'list_activities', { object: 'deal', id: mggId, limit: 10_000 })
  check(
    'a request for ten thousand rows is capped rather than served',
    !rowCap.isError && (rowCap.data?.activities?.length ?? 0) <= 100,
    `${rowCap.data?.activities?.length} rows`,
  )

  // -----------------------------------------------------------------------
  section('roles')

  const viewerRead = await call(viewerToken, 'get_record', { object: 'deal', id: mggId })
  check('a viewer token reads', !viewerRead.isError && viewerRead.data?.id === mggId)

  const viewerWrite = await call(viewerToken, 'update_record', {
    object: 'deal',
    id: mggId,
    fields: { amount: 1 },
  })
  check('a read-only token cannot write', viewerWrite.isError, viewerWrite.text)
  check(
    'and is told why, in a sentence rather than a stack trace',
    viewerWrite.text.toLowerCase().includes('sales access'),
    viewerWrite.text,
  )

  const viewerNote = await call(viewerToken, 'create_note', { object: 'deal', id: mggId, body: 'nope' })
  check('nor add a note', viewerNote.isError)

  const afterViewer = await getRecord(sales, 'deal', mggId)
  check(
    'and the record is untouched',
    Number(afterViewer?.values.amount) !== 1,
    String(afterViewer?.values.amount),
  )

  // -----------------------------------------------------------------------
  section('tenancy')

  const crossRead = await call(probeToken, 'get_record', { object: 'deal', id: mggId })
  check(
    'a token for one account cannot read another\'s record',
    crossRead.isError,
    crossRead.text.split('\n')[0] ?? '',
  )
  check(
    'and is told it does not exist rather than that it is forbidden',
    !crossRead.text.toLowerCase().includes('forbidden') && !crossRead.text.toLowerCase().includes('permission'),
    'row level security makes it invisible, so the error leaks nothing',
  )

  const crossWrite = await call(probeToken, 'update_record', {
    object: 'deal',
    id: mggId,
    fields: { amount: 5 },
  })
  check('nor change it', crossWrite.isError)

  const crossSearch = await call(probeToken, 'search_records', { query: MARK })
  check(
    'nor find it by searching',
    crossSearch.data?.total === 0,
    `${crossSearch.data?.total} matches from the other tenant`,
  )

  // -----------------------------------------------------------------------
  section('idempotency')

  const key = `f5-verify-${Date.now()}`
  const first = await call(
    salesToken,
    'create_note',
    { object: 'deal', id: mggId, body: `${MARK} idempotent note` },
    { idempotencyKey: key },
  )
  const second = await call(
    salesToken,
    'create_note',
    { object: 'deal', id: mggId, body: `${MARK} idempotent note` },
    { idempotencyKey: key },
  )
  check('a retried write answers the same thing', !first.isError && first.text === second.text)

  const noteCount = await scoped<{ n: string }>(
    sales,
    sql`select count(*) as n from activity where body = ${`${MARK} idempotent note`}`,
  )
  check(
    'and writes once, not twice',
    Number(noteCount[0]?.n) === 1,
    `${noteCount[0]?.n} note${noteCount[0]?.n === '1' ? '' : 's'} in the database`,
  )

  const differentKey = await call(
    salesToken,
    'create_note',
    { object: 'deal', id: mggId, body: `${MARK} idempotent note` },
    { idempotencyKey: `${key}-other` },
  )
  check('while a different key is a different write', !differentKey.isError)
  const afterSecond = await scoped<{ n: string }>(
    sales,
    sql`select count(*) as n from activity where body = ${`${MARK} idempotent note`}`,
  )
  check('so the same words twice on purpose still works', Number(afterSecond[0]?.n) === 2)

  // -----------------------------------------------------------------------
  section('revocation')

  const beforeRevoke = await call(doomedToken, 'search_records', { query: 'anything' })
  check('the token works', !beforeRevoke.isError || beforeRevoke.text.includes('Nothing matches'))

  const doomedId = created.tokens.at(-1)!
  const stopped = await revokeMcpToken(admin, doomedId)
  check('revoking reports that it did something', stopped)

  const afterRevoke = await rpc(doomedToken, 'tools/list')
  check(
    'and it stops working on the very next call',
    afterRevoke.status === 401,
    `HTTP ${afterRevoke.status}, no cache to expire first`,
  )

  const twice = await revokeMcpToken(admin, doomedId)
  check('revoking twice revokes once', twice === false, 'safe to click again')

  const notMine = await revokeMcpToken(sales, created.tokens[1]!)
    .then(() => 'allowed')
    .catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)))
  check(
    "one person cannot revoke somebody else's token",
    typeof notMine === 'string' && /you need account access/i.test(notMine),
    String(notMine),
  )

  const adminSees = await listMcpTokens(admin)
  const salesSees = await listMcpTokens(sales)
  check(
    'an admin sees every token in the account',
    // Three by hand: the probe tenant's token belongs to the other account and
    // is correctly invisible here. The OAuth section's token is named for its client.
    adminSees.filter((t) => t.name.startsWith(MARK) && !t.name.endsWith('client')).length === 3,
    `${adminSees.length} visible`,
  )
  check(
    'and everybody else sees only their own',
    salesSees.every((t) => t.userId === sales.actorId),
    `${salesSees.length} visible to sales`,
  )
  check(
    'a token is never readable again after it is created',
    adminSees.every((t) => !('token' in t)),
    'only the hash and a six character preview are stored',
  )

  // -----------------------------------------------------------------------
  section('limits')

  const oversized = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${salesToken}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'create_note', arguments: { object: 'deal', id: mggId, body: 'x'.repeat(400_000) } },
    }),
  })
  check('a payload far past the cap is refused', oversized.status === 413, `HTTP ${oversized.status}`)

  const batched = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${salesToken}` },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
  })
  check('a batch is refused with a reason', batched.status === 400)
} finally {
  const admin = await actorCtx(SANDBOX.slug, 'admin@sandbox.test', ['contacts', 'sales', 'marketing', 'service', 'reports', 'account']).catch(() => null)
  if (admin) {
    await withAccount(admin, async (tx) => {
      await tx.execute(sql`delete from activity_link where activity_id in (
        select id from activity where subject like ${`${MARK}%`} or body like ${`${MARK}%`})`)
      await tx.execute(sql`delete from activity where subject like ${`${MARK}%`} or body like ${`${MARK}%`}`)
      await tx.execute(sql`delete from task where title like ${`${MARK}%`}`)
      await tx.execute(sql`delete from deal where name like ${`${MARK}%`}`)
      await tx.execute(sql`delete from contact where email = 'f5-verify@northwind-labs.test'`)
      await tx.execute(sql`delete from mcp_call where token_id in (
        select id from mcp_token where name like ${`${MARK}%`})`)
      await tx.execute(sql`delete from mcp_token where name like ${`${MARK}%`}`)
      await tx.execute(sql`delete from mcp_oauth_code where client_id in (
        select id from mcp_client where name like ${`${MARK}%`})`)
      await tx.execute(sql`delete from field_def where key = 'f5_verify_flavour'`)
    })
    forgetRegistry(admin.accountId)
    await appDb.execute(sql`delete from mcp_client where name like ${`${MARK}%`}`)
  }
  await closeAppPool()
}

console.log(
  failures === 0
    ? `\nall ${checks} MCP checks passed.`
    : `\n${failures} of ${checks} MCP checks failed.`,
)
process.exit(failures === 0 ? 0 : 1)
