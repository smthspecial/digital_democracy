# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config
COPY services/ts/budget-service/package.json ./services/ts/budget-service/package.json
RUN pnpm install --frozen-lockfile --filter @dd/budget-service...

FROM deps AS build
COPY services/ts/budget-service ./services/ts/budget-service
RUN pnpm --filter @dd/budget-service build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app/services/ts/budget-service/dist ./dist
COPY --from=build /app/services/ts/budget-service/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
