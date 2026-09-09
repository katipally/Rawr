# One image, three ways to run it. The app and the job daemon are the same build,
# the same dependencies and the same code, differing only in what they are told to
# start:
#
#   node apps/web/server.js         the app
#   node apps/worker/src/index.ts   the job daemon
#   node scripts/both.mjs           both, for a host that sells one process
#
# Two containers is the shape to prefer; the third command is what makes a free
# tier workable without changing anything about the code. See DEPLOY.md.

# The engines field says >=24 and @types/node is pinned to 24's, so the runtime is
# pinned to 24 too: types describing a newer runtime are a typecheck that passes
# and a call that throws. Node 24 runs the TypeScript sources directly, which is
# why the worker needs no build step of its own.
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
# corepack reads packageManager from package.json, so the pnpm version is the one
# the lockfile was written by rather than whatever is newest today.
RUN corepack enable
WORKDIR /repo


# --- dependencies -----------------------------------------------------------
# Manifests only, so this layer is rebuilt when a dependency changes and reused
# when only source does. Every workspace package needs its package.json present
# before install, or pnpm resolves a workspace that is not there yet.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/db/package.json packages/db/
COPY packages/ui/package.json packages/ui/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile


# --- build ------------------------------------------------------------------
FROM base AS build
COPY --from=deps /repo/ /repo/
COPY . .

# next build sets NODE_ENV=production and renders pages, which reaches the env
# module. These are parseable placeholders that never connect: the real values
# arrive at boot, where assertProductionSecrets refuses exactly these.
#
# ARG rather than ENV, so they are visible to the build and are not written into
# the image's config. Nothing here is a secret, and an image that carries a
# variable named AUTH_SECRET invites somebody to trust it.
ARG DATABASE_URL=postgres://build:build@127.0.0.1:5432/none
ARG DATABASE_URL_OWNER=postgres://build:build@127.0.0.1:5432/none
ARG AUTH_SECRET=build-time-placeholder-at-least-32-chars
ARG AUTH_URL=http://localhost:3000
RUN pnpm --filter @rawr/web build


# --- runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
# Next reads these to bind. 0.0.0.0 because a container listening on localhost is
# a container nothing outside it can reach.
ENV PORT=3000 HOSTNAME=0.0.0.0

# The worker gets no Next build and so no dependency tracing, and it cannot be
# given a flattened tree either: `packages/db` ships TypeScript source, and Node
# refuses to strip types from any file whose real path is inside node_modules.
# `pnpm deploy` puts it exactly there, so the worker fails at its first import.
#
# So the worker keeps the repository's own layout, where pnpm links `@rawr/db` out
# to `packages/db` and the real path is therefore not under node_modules -- the
# same reason it runs on a laptop. `--filter @rawr/worker...` installs the worker
# and what it depends on and nothing else; `--prod` drops the toolchain. These
# come from the build context rather than the build stage so that .dockerignore
# keeps the laptop's node_modules out of them.
#
# It runs before the app is copied in, so a resolver walking up from
# apps/web/server.js finds a finished tree rather than a half-written one.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/package.json
COPY packages/ui/package.json ./packages/ui/package.json
COPY apps/worker ./apps/worker
COPY packages/db ./packages/db
COPY scripts/both.mjs ./scripts/both.mjs
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --filter @rawr/worker...

# `output: 'standalone'` traced the imports the server actually reaches and copied
# them, workspace packages included, with pnpm's symlinks resolved. So the app is
# these three copies and no install step of its own. `standalone` is laid out from
# the repository root, which is why server.js ends up under apps/web.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

# Drops root after the copies, so the files are owned by root and read-only to the
# process serving the internet.
USER node

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
