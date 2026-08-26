import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildServer } from "./server.js";
import { config } from "./config.js";
import { createPool, runMigrations } from "./db.js";
import { PgCitizenRepository } from "./repositories/citizen.js";
import { PgVerificationRepository } from "./repositories/verification.js";
import { LoggingEventPublisher } from "./events.js";
import { stubVerifyEvidence } from "./verification-provider.js";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const pool = createPool(config.databaseUrl);
await runMigrations(pool, migrationsDir);

const app = buildServer({
  citizenRepo: new PgCitizenRepository(pool),
  verificationRepo: new PgVerificationRepository(pool),
  events: new LoggingEventPublisher(console),
  verifyEvidence: stubVerifyEvidence,
  identityHashSecret: config.identityHashSecret,
});

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
