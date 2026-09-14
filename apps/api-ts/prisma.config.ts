import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// CLI-only config (migrate/studio/db). Runtime PrismaClient connections are
// separate (src/prisma/prisma.service.ts, ADR-030) so api_app/api_worker can
// each bind to their own role -- this file just needs *a* connection able to
// create/alter the schema, roles, and policies (MIGRATE_DATABASE_URL: the
// Postgres superuser in dev, per ADR-029's precedent of deferring
// role-separated migration credentials).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("MIGRATE_DATABASE_URL"),
  },
});
