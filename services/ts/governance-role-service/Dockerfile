# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config
COPY services/ts/governance-role-service/package.json ./services/ts/governance-role-service/package.json
RUN pnpm install --frozen-lockfile --filter @dd/governance-role-service...

FROM deps AS build
COPY services/ts/governance-role-service ./services/ts/governance-role-service
RUN pnpm --filter @dd/governance-role-service build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app/services/ts/governance-role-service/dist ./dist
COPY --from=build /app/services/ts/governance-role-service/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
