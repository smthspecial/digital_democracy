# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config
COPY services/ts/identity-service/package.json ./services/ts/identity-service/package.json
RUN pnpm install --frozen-lockfile --filter @dd/identity-service...

FROM deps AS build
COPY services/ts/identity-service ./services/ts/identity-service
RUN pnpm --filter @dd/identity-service build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app/services/ts/identity-service/dist ./dist
COPY --from=build /app/services/ts/identity-service/migrations ./migrations
COPY --from=build /app/services/ts/identity-service/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
