-- Local-dev Postgres bootstrap for compose (ADR-026, ARCH-025 §4, ADR-028).
--
-- One shared Postgres *server* for local dev, one *database* per app
-- (ADR-028): api_go holds all four Go services' tables (apps/api-go,
-- migrated automatically at boot via ADR-029); api_ts holds the fourteen
-- TypeScript domain modules' tables (apps/api-ts, 31-model Prisma schema,
-- migrated 2026-09-09..2026-09-11 -- but NOT automatically at boot, unlike
-- api-go: run `pnpm --filter @dd/api-ts exec prisma migrate deploy` against
-- it once, per ADR-030 and docker-compose.yml's header).
--
-- IMPORTANT: this file only creates the two databases. Role separation
-- (api_app/api_worker) is created and enforced by each app's own migration
-- the first time it runs against its database -- api-go's automatically at
-- boot, api-ts's only once `prisma migrate deploy` has been run by hand.

CREATE DATABASE api_go;
CREATE DATABASE api_ts;
