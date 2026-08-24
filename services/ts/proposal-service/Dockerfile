# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config
COPY services/ts/proposal-service/package.json ./services/ts/proposal-service/package.json
RUN pnpm install --frozen-lockfile --filter @dd/proposal-service...

FROM deps AS build
COPY services/ts/proposal-service ./services/ts/proposal-service
RUN pnpm --filter @dd/proposal-service build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app/services/ts/proposal-service/dist ./dist
COPY --from=build /app/services/ts/proposal-service/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
