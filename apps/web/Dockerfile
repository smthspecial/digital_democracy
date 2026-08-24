# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config
COPY packages/api-client ./packages/api-client
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @dd/web...

FROM deps AS build
COPY apps/web ./apps/web
RUN pnpm --filter @dd/web build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next ./apps/web/.next
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
USER node
CMD ["node_modules/.bin/next", "start", "apps/web"]
