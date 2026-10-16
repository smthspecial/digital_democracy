# Build: podman build -t digital-democracy/api-ts:dev -f apps/api-ts/Dockerfile .
# (or: make docker-build SERVICE=api-ts)
# Context is the repo root: this is a pnpm workspace member, and the build
# needs packages/tsconfig (apps/api-ts/tsconfig.json extends it) and
# packages/eslint-config (declared as a workspace:* devDependency, so pnpm
# needs it present to resolve the install even though it's unused at build
# time) alongside apps/api-ts itself. Single build stage that keeps the
# whole /src tree intact into the runtime stage rather than relocating
# dist/+node_modules -- pnpm's default symlinked node_modules layout
# (per-package node_modules symlinking into a root .pnpm store) does not
# survive being torn apart and reassembled by selective COPYs across stages.
FROM docker.io/library/node:24-alpine AS build
WORKDIR /src
RUN corepack enable
# pnpm refuses to prune node_modules non-interactively otherwise
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) -- there's no TTY in a
# container build.
ENV CI=true
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY patches/ patches/
COPY packages/tsconfig/ packages/tsconfig/
COPY packages/eslint-config/ packages/eslint-config/
COPY apps/api-ts/package.json apps/api-ts/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api-ts/ apps/api-ts/
RUN MIGRATE_DATABASE_URL=postgresql://unused:unused@localhost:5432/unused pnpm --filter @dd/api-ts exec prisma generate
RUN pnpm --filter @dd/api-ts build

# The migration image retains the CLI; runtime never receives its admin URL.
FROM build AS migration
RUN adduser -D -H -u 10001 appuser
RUN rm /src/pnpm-lock.yaml
RUN rm -rf /src/apps/api-ts/src /src/apps/api-ts/dist /src/apps/api-ts/.env.example
RUN apk upgrade --no-cache && rm -rf /root/.cache /usr/local/lib/node_modules /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /src/apps/api-ts
USER 10001:10001
ENTRYPOINT ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM build AS production-dependencies
# Prune devDependencies now that the build (tsc) and prisma generate (whose
# CLI is a devDependency, but whose generated output lands in @prisma/client,
# a prod dependency) are both done.
RUN pnpm install --frozen-lockfile --prod --filter=@dd/api-ts...
RUN rm /src/pnpm-lock.yaml

FROM docker.io/library/node:24-alpine
RUN apk upgrade --no-cache && adduser -D -H -u 10001 appuser && rm -rf /usr/local/lib/node_modules /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=production-dependencies --chown=appuser:appuser /src /src
RUN rm -rf /src/apps/api-ts/src /src/apps/api-ts/dist/test-support /src/apps/api-ts/prisma /src/apps/api-ts/prisma.config.ts /src/apps/api-ts/.env.example
WORKDIR /src/apps/api-ts
USER 10001:10001
EXPOSE 4000
ENV PORT=4000 APP_ENV=production
ENTRYPOINT ["node", "dist/main.js"]
