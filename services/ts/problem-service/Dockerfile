# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config
COPY packages/event-bus/package.json ./packages/event-bus/package.json
COPY services/ts/problem-service/package.json ./services/ts/problem-service/package.json
RUN pnpm install --frozen-lockfile --filter @dd/problem-service...

FROM deps AS build
COPY packages/event-bus ./packages/event-bus
COPY services/ts/problem-service ./services/ts/problem-service
# @dd/event-bus (ADR-023) is a real runtime dependency, not a dev-only
# one -- its own dist/ must exist before this service's compiled JS can
# resolve it, so build the whole dependency graph, not just this service.
RUN pnpm --filter @dd/problem-service... build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
# pnpm's per-package node_modules/@dd/event-bus symlink is relative and
# directory-depth-sensitive -- the runtime image has to preserve the same
# directory depth as the build stage, not flatten everything to /app, or
# the symlink dangles and `node dist/index.js` can't resolve @dd/event-bus.
COPY --from=build /app/services/ts/problem-service/dist ./services/ts/problem-service/dist
COPY --from=build /app/services/ts/problem-service/package.json ./services/ts/problem-service/package.json
COPY --from=build /app/services/ts/problem-service/node_modules ./services/ts/problem-service/node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
WORKDIR /app/services/ts/problem-service
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
