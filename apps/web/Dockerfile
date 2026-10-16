# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config
COPY packages/api-client ./packages/api-client
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @dd/web...

FROM deps AS build
COPY apps/web ./apps/web
RUN pnpm --filter @dd/web build

FROM node:24-alpine AS runtime
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
USER node
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web"]
