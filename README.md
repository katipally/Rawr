# Rawr

Internal HubSpot replacement for Datasaur. The plan lives in `docs/`; read
`docs/README.md` first. This file is only how to run it.

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
 pnpm verify              typecheck, then both suites below
 pnpm db:verify           tenancy: RLS forced everywhere, cross-tenant reads and writes refused
 pnpm db:verify:guards    the role matrix and the audit trail, by calling mutations directly
```

Both suites run against the real database and exit non-zero on failure, so they
can gate a build. `/design` renders every primitive in its empty, single-row and
500-character states; `/design?rows=10000` is the large-result check.
