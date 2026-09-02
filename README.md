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

Until Google OAuth credentials exist (open item 3), sign in at `/sign-in` with a
seeded address: `ivan@datasaur.ai` is admin, `trevor@` is sales, `andrew@` is
marketing, `viewer@` is viewer, and `admin@probe.example` is the second tenant.
That form refuses to render unless `RAWR_DEV_LOGIN=1` and `NODE_ENV` is not
production.

## Checking it still holds

```
 pnpm verify              typecheck, then every suite below
 pnpm db:verify           tenancy: RLS forced everywhere, cross-tenant reads and writes refused
 pnpm db:verify:guards    the role matrix and the audit trail, by calling mutations directly
 pnpm db:verify:crm       F1: board totals, merge, dedupe, import, search, export
 pnpm db:verify:forms     F3: schema rules, spam scoring, capture, review queue, attribution
```

`pnpm verify` runs all nine. One of them needs the app up: `verify:mcp` calls the
real `/api/mcp`. Start it with a small pool, or the suites and the dev server
together exhaust the Supabase pooler and the failures read as logic errors:

```
 DATABASE_POOL_MAX=3 pnpm dev    in one terminal
 pnpm verify                     in another
```

All of them run against the real database and exit non-zero on failure, so they
can gate a build. `/design` renders every primitive in its empty, single-row and
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

Turnstile, Slack and the Webflow secret are all optional in development. Without
Turnstile a submission that scores into the challenge band fails closed to the
review queue rather than being accepted or lost.
