# Deploying Rawr

Three things run: the app, the job daemon, and Postgres with an S3-compatible
bucket beside it. The first two are the same container image told to start
different files, so nothing about a move between hosts touches the code.

```
 node apps/web/server.js         the app
 node apps/worker/src/index.ts   the job daemon
 node scripts/both.mjs           both, for a host that sells one process
```

Prefer two containers. A job that wedges or leaks then takes down the daemon and
not the app people are looking at. `scripts/both.mjs` exists because on a free
tier the alternative is that nothing scheduled runs at all; it supervises rather
than backgrounds, so either process exiting takes the container down and the host
restarts it.

## The image

```
 docker build -t rawr .
 docker run -p 3000:3000 --env-file .env.docker rawr
```

**Not `.env.local`.** `node --env-file` strips the quotes around a value and
`docker run --env-file` does not, so a quoted URL arrives with its quotes still
attached and the driver rejects it as "Invalid URL". Write an unquoted file for
Docker:

```
 sed 's/^\([A-Z_]*\)="\(.*\)"$/\1=\2/' .env.local > .env.docker
```

A real host does not have this problem: Render, Fly and the rest take key and
value as separate fields, so there are no quotes to strip.

Nothing is baked in but code: every value arrives at boot. The build stage sets
four placeholder variables because `next build` renders pages that read the
environment, and `assertProductionSecrets` refuses exactly those placeholders when
a server actually starts on them.

Node 24 runs the TypeScript sources directly, so the worker has no build step.
That is also why the image keeps the repository's layout rather than flattening
the worker into a self-contained directory: `packages/db` ships TypeScript, and
Node refuses to strip types from any file whose real path is inside
`node_modules`. Laid out as a workspace, pnpm links `@rawr/db` out to
`packages/db` and the real path is not under `node_modules`.

## Database

Any Postgres 15 or newer. Three URLs, and they are not interchangeable:

```
 DATABASE_URL          the app. A transaction pooler is fine and preferred.
 DATABASE_URL_SESSION  pg-boss. Must outlive one statement, so session mode.
 DATABASE_URL_OWNER    migrations and the worker's own bookkeeping.
```

On Supabase, `DATABASE_URL` is the pooler on `:6543` and the other two are
`:5432`, with the user `rawr_app.PROJECT_REF`. Leave `DATABASE_PREPARED` unset
there; set it to `1` on a direct connection.

Migrations run from the image, against the same environment:

```
 docker run --env-file .env.local rawr pnpm db:migrate
```

`APP_DB_PASSWORD` on a fresh database creates the `rawr_app` role. Clear it
afterwards, or a later migration resets the password `DATABASE_URL` is using.

## Storage

Any S3-compatible bucket, kept private: every read is a link signed per request.
On Supabase the endpoint is `https://PROJECT_REF.supabase.co/storage/v1/s3` with
keys from Storage, Settings, S3 access keys — not the `service_role` key. Without
it the Files panel says it is not connected rather than half working.

## Sign-in

Google, and nothing else. Register the callback on the OAuth client:

```
 https://<host>/api/auth/google/callback
```

Leave `RAWR_CALENDAR_AT_SIGNIN` at `0` until Google has verified the client. The
calendar scopes are "restricted", and an unverified client asking for them can
have the whole authorisation refused — which locks people out of the CRM, not
just out of their calendar. Hosts connect a calendar from Meetings, Calendars in
the meantime.

Who gets a seat, in order:

```
 the database is empty   whoever signs in first opens the account and owns it.
                         Fires once, ever.
 a claimed domain        they join that account on its default view grants
 an invitation           the seat it was written for
 anybody else            RAWR_VISITOR_ACCOUNT, able to read and change nothing,
                         or no seat at all when it is empty
```

Set `RAWR_VISITOR_ACCOUNT` to the slug of the account the first sign-in opened.
For a deployment serving one company, leave it empty and set
`GOOGLE_HOSTED_DOMAIN` instead.

## Secrets

The server refuses to boot on development placeholders and names which:

```
 AUTH_SECRET            32+ characters
 RAWR_INTERNAL_SECRET   the same value on the app and the worker
 EDGE_IP_SALT           16+ characters; rotating it re-hashes visitor IPs
 TOKEN_ENCRYPTION_KEY   32 bytes, or Gmail and Calendar grants cannot be stored
```

```
 node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`TOKEN_ENCRYPTION_KEY` must come from the host's secret store, never from the
database it protects.

## What it needs to run

Measured against the built image, driving real pages with a real session:

```
 idle                     211 MB
 under request load       251 MB
 authenticated CRM pages  263 MB
 cold start to healthy    63s on a tenth of a CPU
```

So it fits a 512 MB box with room to spare, and a tenth of a CPU renders a warm
CRM page in one to three seconds. Half a gigabyte is the floor; below that the
Next server and the job daemon in one process will not both fit.

## Host notes

`TRUSTED_PROXY_HOPS` has to match how many proxies you actually run, or the
per-IP rate limits are either spoofable or shared by everybody. One is the usual
shape. `PUBLIC_BASE_URL` is where the public edge is reachable from outside; the
embed and hosted form pages build absolute URLs from it and are served onto other
origins, so it is never inferred from the request host.

HSTS is deliberately not set by the app. It is a promise about the whole origin
that cannot be taken back for two years, so it belongs in the terminating proxy's
config next to the certificate.

`GET /healthz` returns 200 with the database round-trip time, or 503 naming the
failure. Point the host's health check at it.

### A free tier that sleeps

A host that suspends an idle service, and a Postgres that pauses itself after a
quiet week, are both answered by the same thing: something outside calling
`/healthz` on a schedule. Outside is the whole point — a sleeping service cannot
wake itself.

Run `node scripts/both.mjs` there, so the job daemon lives in the one process the
host gives you.

**Wake on cron, not on an interval.** Two schedules run at a fixed time of day:

```
 30 3 * * *   activity roll-up
 0 7 * * *    the notification sweep
```

A service asleep at 03:30 does not run that day's roll-up — pg-boss creates the
job when the clock strikes, and nothing is there to strike it. An interval pinger
("every 6 hours") lands wherever it happens to land, so aim the wakes instead.
Anything that speaks cron does this; cron-job.org and a GitHub Actions schedule
are both free:

```
 25 3 * * *    wakes it before the roll-up
 55 6 * * *    wakes it before the sweep
 0 12,18 * * * two more, so the day never goes quiet
```

Four wakes a day, each holding the service up for its 15-minute idle window, is
about 31 instance hours a month against a 750-hour grant, and it keeps Postgres
from its own inactivity pause. Staying awake around the clock costs 744 of those
750 hours in a 31-day month, which leaves no room for a second free service.

Everything on `* * * * *` — sequence steps, automations, enrichment, visitor
stitching — simply runs while the service is up and waits while it is not. A
visitor arriving cold waits about a minute for the first page.
