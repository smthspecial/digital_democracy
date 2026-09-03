# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config
COPY packages/event-bus/package.json ./packages/event-bus/package.json
COPY services/ts/proposal-service/package.json ./services/ts/proposal-service/package.json
RUN pnpm install --frozen-lockfile --filter @dd/proposal-service...

FROM deps AS build
COPY packages/event-bus ./packages/event-bus
COPY services/ts/proposal-service ./services/ts/proposal-service
# @dd/event-bus (ADR-023) is a real runtime dependency, not a dev-only one --
# its own dist/ must exist before proposal-service's compiled JS can resolve
# it, so build the whole dependency graph, not just proposal-service.
RUN pnpm --filter @dd/proposal-service... build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
# pnpm's per-package node_modules/@dd/event-bus symlink is relative
# (../../../../../packages/event-bus, five levels up from
# services/ts/proposal-service/node_modules/@dd/) -- the runtime image has
# to preserve that same directory depth, not flatten everything to /app, or
# the symlink dangles and `node dist/index.js` can't resolve @dd/event-bus
# at all (confirmed by hand: flattening is exactly what broke this the
# first time this Dockerfile was written).
COPY --from=build /app/services/ts/proposal-service/dist ./services/ts/proposal-service/dist
COPY --from=build /app/services/ts/proposal-service/package.json ./services/ts/proposal-service/package.json
COPY --from=build /app/services/ts/proposal-service/node_modules ./services/ts/proposal-service/node_modules
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
WORKDIR /app/services/ts/proposal-service
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
