# syntax=docker/dockerfile:1
FROM node:20-alpine AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/tsconfig ./packages/tsconfig
COPY packages/eslint-config ./packages/eslint-config
COPY services/ts/competency-service/package.json ./services/ts/competency-service/package.json
RUN pnpm install --frozen-lockfile --filter @dd/competency-service...

FROM deps AS build
COPY services/ts/competency-service ./services/ts/competency-service
RUN pnpm --filter @dd/competency-service build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production
COPY --from=build /app/services/ts/competency-service/dist ./dist
COPY --from=build /app/services/ts/competency-service/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
EXPOSE 8080
USER node
CMD ["node", "dist/index.js"]
