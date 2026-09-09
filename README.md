# Rawr

Datasaur's own CRM, built to replace HubSpot. One account, one database, and
every screen HubSpot gives us that we actually use.

```
 apps/web        Next.js: the app, and the public edge strangers reach
 apps/worker     pg-boss daemon: scheduled jobs, retries, dead letters
 packages/db     schema, migrations, and the tenant-scoped data access layer
 packages/ui     design tokens and the shared primitives
```

Needs Node 24+ and pnpm 11 (`packageManager` pins the version, so `corepack
enable` is enough) and any Postgres 15+. Nothing in the schema, the policies or
the data layer is vendor-specific.

## Setup

```
 pnpm install
 cp .env.example .env.local     # fill in the three database URLs
 pnpm db:migrate                # schema, then row level security on every table
 pnpm db:seed                   # two fixture accounts, ~20 records each
```

Every script reads `.env.local` through `node --env-file-if-exists`, so that file
is how a laptop supplies configuration and its absence is how a deployment does.

The app connects as `rawr_app`, which owns no tables and cannot bypass row level
security. `DATABASE_URL_OWNER` is the table owner, used by migrations and by
pg-boss, and must not be a transaction pooler: both need a session that outlives
one statement. `DATABASE_URL_SESSION` is read by the tenancy suite alone, which
wants a second handle to prove one tenant cannot reach another.

`pnpm db:migrate` runs `packages/db/sql/bootstrap.sql` first, which creates the
`extensions` schema and the `rawr_app` role if they are absent. Set
`APP_DB_PASSWORD` on a fresh database to give that role a password. Both are
idempotent, so an existing database is untouched.

On Supabase, point `DATABASE_URL` at the pooler on `:6543` (transaction mode) and
the other two at `:5432` (session mode), with the user `rawr_app.PROJECT_REF`.
Set `DATABASE_PREPARED` to `0` there; `1` on a direct connection.

## Running

```
 pnpm dev        the app on http://localhost:3000
 pnpm worker     the job daemon — nothing scheduled happens without it
```

Sign in with Google. There is no other way in: no passwords, no magic links, and
nothing that takes an address on trust.

What that sign-in gets you is settled in `rawr.sign_in_google`, in order:

```
 the database is empty   whoever signs in first opens the account and owns it.
                         Fires once, ever, which is how this starts from nothing.
 a claimed domain        they join that account on its default view grants
 an invitation           the seat it was written for, checked against the
                         address they actually signed in with
 anybody else            RAWR_VISITOR_ACCOUNT, able to read and change nothing,
                         or no seat at all when that is empty
```

Set `RAWR_VISITOR_ACCOUNT` on a deployment anyone may look around; leave it empty
and set `GOOGLE_HOSTED_DOMAIN` on one that serves a single company.

The seeded fixture accounts are for the verify suites, which reach the database
directly. Nothing signs in as them.

## Commands

```
 pnpm dev                     the app, with hot reload
 pnpm worker                  the job daemon
 pnpm build                   production build of the app
 pnpm typecheck               tsc across all four packages
 pnpm lint                    biome, everything including warnings
 pnpm lint:ci                 biome, errors only — this is the gate
 pnpm test                    unit tests; no database needed

 pnpm db:migrate              apply migrations, then re-apply tenancy
 pnpm db:seed                 rebuild the sandbox and peer fixture accounts
 pnpm db:generate             drizzle-kit generate — see the warning below
 pnpm db:reclaim              give disk back after the scale suite
 pnpm db:probe:large          find oversized stored values

 pnpm verify                  everything below, in order, as a build gate

 docker build -t rawr .       the deployable image — see DEPLOY.md
```

`pnpm verify` runs typecheck, lint, the unit tests, and sixteen suites against
the real database. Each exits non-zero on failure:

```
 db:verify:sql            every table, column and rawr.* function named in raw
                          SQL exists — typecheck cannot see inside a template
 db:verify                tenancy: RLS forced everywhere, cross-tenant reads
                          and writes refused, audit_log immutable
 db:verify:guards         the permission grid and the audit trail, by calling
                          mutations directly
 db:verify:account        seats, invitations, grants, teams, scope, history
 db:verify:crm            board totals, merge, dedupe, import, search, export
 db:verify:admin          custom fields, pipelines, stages, lifecycle
 db:verify:objects        objects an admin invents, and their rows
 db:verify:forms          schema rules, spam scoring, capture, review queue
 db:verify:booking        availability, holds, double-booking, timezones
 db:verify:mail           stored bodies, who may read a mailbox, the inbox
 db:verify:sequences      enrolment, the queue, tracking, every way one stops
 db:verify:integrations   connection tests, health, idempotency, replay
 db:verify:mcp            the agent surface, against the real /api/mcp — so
                          this one needs the app running
 db:verify:reporting      attribution, first-touch rules, totals reconciling
 db:verify:activity       page views, sessions, visitor stitching, retention
 db:verify:notifications  the bell, the drawer, the nightly sweep
```

Because of that one, `pnpm verify` needs the app up. Give it a small pool, or the
suites and the dev server together exhaust the connection limit and the failures
read as logic errors:

```
 DATABASE_POOL_MAX=5 pnpm dev    in one terminal
 pnpm verify                     in another
```

Not in `pnpm verify`, run on purpose: `pnpm db:verify:scale` builds 100,000
contacts (`SCALE_CONTACTS` to change it) and measures the queries against them.
`pnpm db:reclaim` gives the disk back afterwards.

The suites run inside the two fixture accounts and leave records behind. Nothing
reseeds on its own: `pnpm db:seed` drops `sandbox` and `peer` and everything
cascading from them, so run it deliberately. It touches no other account, and
refuses outright if a fixture slug is seated by somebody who signed in with
Google.

**`pnpm db:generate` is not safe to run.** The drizzle snapshots under
`migrations/meta/` stop at `0009`; every migration since was written by hand and
the journal appended by hand. Generating would diff the live schema against a
fifty-migration-old snapshot and emit a migration recreating half the database.
Write the SQL and add the journal entry by hand, as every migration since 0010
has been.

## What each part does

### CRM

- **Records** — Contacts, Companies and Deals, plus any object an admin invents
  under Settings, Data Model. Each gets a list, a board, a calendar view and a
  record page, all from the same builders.
- **Views** — saved filter sets per object, addressable and pinnable. Filters,
  sort, columns and the page you are on all live in the URL, so any screen can
  be pasted to somebody else.
- **Record page** — three columns HubSpot-style: properties, the activity
  timeline, and associations. Log a call, start a task or compose an email from
  the quick-action row.
- **Segments (Lists)** — audiences built from filters, recomputed on write and
  hourly. Members are stored, so a segment's size is a count rather than a scan.
- **Tasks** — due dates, owners, and views for today, overdue and upcoming.
- **Inbox** — the shared view of every connected mailbox, filtered by scope,
  unread and unreplied.
- **Duplicates** — candidate pairs by email, domain and name, merged or
  dismissed one at a time.
- **Import / Export** — CSV and Excel in, with a mapping step, a dry run and a
  per-row error file; CSV out, matching exactly the filters on screen.

### Marketing

- **Forms** — a builder, validation rules shared byte-for-byte with the browser,
  spam scoring, a review queue for anything borderline, and attribution captured
  on submit. Embedded with one script tag or hosted as a page.
- **Newsletter** — the audience and the opt-out are Rawr's, the send is Brevo's.
- **Subscriptions** — named subscription types, opt-in only; an unticked box on
  one form never cancels a choice made on another.

### Sales

- **Calendar** — the month, showing meetings booked and tasks due.
- **Meetings Scheduler** — public booking pages, round-robin or one-to-one, with
  availability rules, buffers, notice, soft holds on a chosen slot, and a hosted
  page that works inside a Webflow embed.
- **Availability** — a person's own working hours, and an admin viewing
  somebody else's.
- **Templates** — reusable message bodies, beside the sequences that use them.
- **Sequences** — multi-step outreach sent from a member's own Gmail, with
  opens, clicks, replies, bounces and unsubscribes tracked, and every rule for
  when one stops.

### Reporting

Six reports over a date range — pipeline, forms, sequences, email, website and
attribution — plus dashboards assembled from their cards. The range is in the
URL, so a report worth looking at is a link.

### Data management

**Data Model** (objects and their fields), **Properties**, **Pipelines** and
their stages, **Lifecycle**, **Event Management** (tracked sites), and
**Connected Apps**.

### Settings

```
 Your preferences   Your account · Agent access
 Account            Account Defaults · Users · Teams · History
 Data management    Objects · Properties · Pipelines · Lifecycle ·
                    Subscriptions · Mailboxes · Calendar connections ·
                    Tracked sites
 Tools              Automations · Integrations · Tracking domain · Failed jobs
```

Access is granted a hub at a time, as HubSpot grants it: contacts, sales,
marketing, service, reports and account, each at view or edit, with a scope
saying how much of it a seat reaches — everything, their team's, or their own —
and super admin above the grid. A hub nobody granted loses its rail icon.

### Connected apps

`/apps` is the one place a provider is connected. Each app has a page of its own
with Overview, Settings and Insights.

```
 Brevo             newsletter sending and campaign events
 Apollo            enrichment, and sequence events read back
 Lusha · Clay      enrichment
 Woodpecker        hand a sequence to a campaign
 HubSpot           read an export
 Slack             notifications
 GA4               custom events forwarded, with consent, minus anything
                   that could name a person
 Zoom              meeting links on a booking
 Google Calendar   free-busy and event writing — per person
 Gmail             mailbox sync and sending — per person
 Turnstile         form challenge
 Webflow           native-form webhook
```

Credentials live in the database, encrypted with `TOKEN_ENCRYPTION_KEY`, never
in the environment. Every provider has a connection test that calls it for real
and reports what it said.

### The worker

Nothing on a schedule happens without `pnpm worker`.

```
 * * * * *      field indexes · visitor stitching · sequence steps ·
                automation rules · enrichment
 */5, */10      mailbox bodies · mailbox sync · sequence leases
 0 * * * *      segment membership
 */30, :15/:45  integration health · Apollo read-back
 30 3, 0 7      activity roll-up · the notification sweep
```

A job that fails past its retries lands in `dead_letter`, visible under
Settings, Failed jobs, and can be replayed.

## The public edge

These take no session. The account is resolved from the form id or the site key
through a security-definer function, never from the request.

```
 GET  /embed.js                 forms + consent, the one file datasaur.ai loads
 GET  /booking.js               the booking embed loader
 GET  /f/:formId/schema         what the embed needs to paint a form
 POST /f/:formId                a submission
 POST /f/:formId/upload         a file on a submission
 GET  /form/:account/:slug      hosted form page
 GET  /b/:account/:slug         public booking page, also the embed
 POST /b/:account/:slug/hold    a soft hold on a slot
 GET  /b/ics/:token.ics         the meeting as a calendar file
 GET  /b/manage/:purpose/:token cancel or reschedule
 POST /c                        a consent choice
 GET  /e                        the analytics collector
 POST /w/:source                provider webhooks (Webflow signature required)
 GET  /t/o/:token, /t/c/:token  sequence open pixel and click redirect
 GET  /u/:token                 unsubscribe
```

To try the embed on a page that is not ours, serve any HTML containing:

```
 <div data-rawr-form="<form id>"></div>
 <script src="http://localhost:3000/embed.js" data-rawr-site="datasaur"
         data-rawr-consent defer></script>
```

Brevo does not sign its webhooks, so saving the Brevo integration mints a token
and the webhook URL carries it as `t=`; posts without it are refused.

## Connecting an assistant

Rawr is an MCP server at `/api/mcp` and its own OAuth 2.1 authorization server,
so a client connects by signing in rather than by pasting a token:

```
 claude.ai / Desktop   Settings, Connectors, Add custom connector, paste the URL
 Claude Code           claude mcp add --transport http rawr http://localhost:3000/api/mcp
 no browser            Settings, Agent access: a token, sent as a bearer header
```

Discovery is at `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server`; consent is at `/oauth/authorize`.
Every tRPC procedure becomes a tool automatically, under the signed-in person's
own grants, so a screen added to the app is reachable by an assistant the same
day.

## In production

**DEPLOY.md** has the whole of it: the image, the three database URLs, the bucket,
the Google client, and what a host that sleeps needs.

The app refuses to boot on the development placeholders for `AUTH_SECRET`,
`RAWR_INTERNAL_SECRET` or `EDGE_IP_SALT`, or on an empty `TOKEN_ENCRYPTION_KEY`,
and names which.

`RAWR_CALENDAR_AT_SIGNIN` stays at `0` until Google has verified the OAuth
client. The calendar scopes are "restricted", and an unverified client asking for
them can have the whole authorisation refused, which locks people out of the CRM
rather than out of their calendar.

Turnstile, Slack and the Webflow secret are optional in development. Without
Turnstile a submission scoring into the challenge band fails closed to the
review queue rather than being accepted or lost.
