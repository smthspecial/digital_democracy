import "dotenv/config";
import { defineConfig, env } from "prisma/config";

if (process.env.APP_ENV === "production") {
  let url: URL;
  try { url = new URL(process.env.MIGRATE_DATABASE_URL ?? ""); }
  catch { throw new Error("Production migration requires a valid database URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
      ["sslmode", "sslaccept", "sslcert"].some(key => url.searchParams.getAll(key).length !== 1) ||
      url.searchParams.get("sslmode") !== "require" ||
      url.searchParams.get("sslaccept") !== "strict" || !url.searchParams.get("sslcert")) {
    throw new Error("Production Prisma migration requires sslmode=require, sslaccept=strict and sslcert");
  }
}

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
