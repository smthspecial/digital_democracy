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
FROM docker.io/library/node:22-alpine AS build
WORKDIR /src
RUN corepack enable
# pnpm refuses to prune node_modules non-interactively otherwise
# (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) -- there's no TTY in a
# container build.
ENV CI=true
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/tsconfig/ packages/tsconfig/
COPY packages/eslint-config/ packages/eslint-config/
COPY apps/api-ts/package.json apps/api-ts/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api-ts/ apps/api-ts/
RUN pnpm --filter @dd/api-ts exec prisma generate
RUN pnpm --filter @dd/api-ts build
# Prune devDependencies now that the build (tsc) and prisma generate (whose
# CLI is a devDependency, but whose generated output lands in @prisma/client,
# a prod dependency) are both done.
RUN pnpm install --frozen-lockfile --prod --filter=@dd/api-ts...

FROM docker.io/library/node:22-alpine
RUN adduser -D -H appuser
COPY --from=build --chown=appuser:appuser /src /src
WORKDIR /src/apps/api-ts
USER appuser
EXPOSE 4000
ENV PORT=4000
ENTRYPOINT ["node", "dist/main.js"]
