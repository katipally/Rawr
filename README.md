# Rawr

Internal HubSpot replacement for Datasaur. The plan lives in `docs/`, which is
local-only and not in this repo; read `docs/README.md` first if you have it.
This file is only how to run it.

```
 apps/web        Next.js: app surfaces + the public edge
 apps/worker     pg-boss daemon: jobs, dead letters, scheduled work
 packages/db     schema, migrations, the tenant-scoped data access layer
 packages/ui     design tokens and the shared primitives
```

## Setup

```
 pnpm install
 cp .env.example .env.local     # fill in the Supabase pooler URLs
 pnpm db:migrate                # schema, then row level security on every table
 pnpm db:seed                   # two workspaces, ~20 records each, edge cases included
```

Needs Node 24+ and pnpm 11 (`packageManager` pins the exact version, so
`corepack enable` is enough). Every script reads `.env.local` directly through
`node --env-file`, so that file has to exist before any `db:` command.
`.agents/` holds agent skills pinned by `skills-lock.json` and is not committed;
Claude Code restores it from that lock.

Both database URLs point at the same Supabase project through different ports:
`:6543` transaction mode for app queries (`prepare: false` is required there), and
`:5432` session mode for migrations and the worker, which hold long-lived
connections. The app connects as `rawr_app`, which owns no tables and cannot
bypass row level security. `DATABASE_URL_OWNER` is the table owner and is used
only by migrations and the worker's own bookkeeping.

## Running

```
 pnpm dev        the web app on http://localhost:3000
 pnpm worker     the job daemon, needs to be running for index builds
```

Sign in with Google: an organisation owns its workspaces and holds the Google
hosted domain, so any verified `@datasaur.ai` account joins the Datasaur
organisation and, while it allows domain joins, every workspace in it as a
viewer. An admin raises the role under Settings, Members; an organisation admin
invites people who are not on the domain, ends somebody's access everywhere at
once, and creates workspaces under Settings, Organisation. Settings, Your account is the person's own screen: roles,
timezone, Gmail and Calendar connections, agent tokens, and sign out everywhere. A seeded address whose email matches is claimed by that
sign-in, so `admin@datasaur.ai` signing in with Google is the seeded admin.

Without Google credentials, `/sign-in` also offers a development form that takes
a seeded address: `admin@datasaur.ai`, `sales@`, `marketing@`, `viewer@`, and
`admin@probe.example` for the second organisation. The seed builds two
organisations, and Datasaur owns two workspaces so the switcher has something to
switch between. That form refuses to render unless
`RAWR_DEV_LOGIN=1` and `NODE_ENV` is not production.

## Checking it still holds

```
 pnpm verify              typecheck, then every suite below
 pnpm db:verify           tenancy: RLS forced everywhere, cross-tenant reads and writes refused
 pnpm db:verify:guards    the role matrix and the audit trail, by calling mutations directly
 pnpm db:verify:org       the organisation layer: scope, seats, invitations, teams, history
 pnpm db:verify:mail      stored bodies, who may read a mailbox, and the shared inbox
 pnpm db:verify:crm       F1: board totals, merge, dedupe, import, search, export
 pnpm db:verify:forms     F3: schema rules, spam scoring, capture, review queue, attribution
```

`pnpm verify` runs all eleven.

## Connecting an assistant

Rawr is an MCP server at `/api/mcp` and its own OAuth 2.1 authorization server, so a
client connects by signing in rather than by pasting a token:

```
 claude.ai / Desktop   Settings, Connectors, Add custom connector, paste the URL
 Claude Code           claude mcp add --transport http rawr http://localhost:3000/api/mcp
 no browser            Settings, Agent access: a token, sent as a bearer header
```

Discovery is at `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server`; consent is `/oauth/authorize`. Every screen has
a tool, under the signed-in person's role. One of them needs the app up: `verify:mcp` calls the
real `/api/mcp`. Start it with a small pool, or the suites and the dev server
together exhaust the Supabase pooler and the failures read as logic errors:

```
 DATABASE_POOL_MAX=5 pnpm dev    in one terminal
 pnpm verify                     in another
```

All of them run against the real database and exit non-zero on failure, so they
can gate a build. They run inside the two seeded workspaces and leave records,
timeline rows and settings behind, so `pnpm verify` ends by reseeding: after a
full run the development data is fresh again. Running one suite on its own does
not reseed; run `pnpm db:seed` when the leftovers get in the way. `/design` renders every primitive in its empty, single-row and
500-character states; `/design?rows=10000` is the large-result check.

## The public edge

F3 adds routes that take no session. The workspace is resolved from the form id
or the site key through a security-definer function, never from the request.

```
 GET  /embed.js               the one file datasaur.ai loads: forms + consent
 GET  /f/:formId/schema       what the embed needs to paint a form
 POST /f/:formId              a submission
 GET  /form/:workspace/:slug  hosted page, works with JavaScript disabled
 GET  /form/:formId           the same page, addressed the way the embed falls back
 POST /c                      a consent choice
 POST /w/webflow              Webflow native-form webhook, signature required
```

To try the embed on a page that is not ours, serve any HTML containing:

```
 <div data-rawr-form="<form id>"></div>
 <script src="http://localhost:3000/embed.js" data-rawr-site="datasaur"
         data-rawr-consent defer></script>
```

A form can hand each new contact to one person or round-robin them across the
admin and sales members (whoever owns the fewest contacts takes the next one), and a
booking hands the contact to its host. Every contact carries Last contacted, Last
reply, Emails sent and Emails received, derived from Gmail, logged activity and
Apollo sequences; views sort on them and segments filter on them.

Brevo does not sign its webhooks. Saving the Brevo integration mints a token, and
the webhook URL shown under Settings, Integrations carries it as `t=`; Brevo posts
without it are refused. The Slack, Apollo, Clay, GA4 and Zoom setup steps are on
each provider's connect form.

In production the app refuses to boot on the development placeholders for
`AUTH_SECRET`, `RAWR_INTERNAL_SECRET`, `EDGE_IP_SALT`, or an empty
`TOKEN_ENCRYPTION_KEY`, and names which.

Turnstile, Slack and the Webflow secret are all optional in development. Without
Turnstile a submission that scores into the challenge band fails closed to the
review queue rather than being accepted or lost.
