import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// The Postgres/RLS integration tier (*.service.spec.ts, *.controller.e2e.spec.ts,
// gated on TEST_TS_DATABASE_URL/TEST_TS_WORKER_DATABASE_URL/TEST_TS_ADMIN_DATABASE_URL --
// mirrors test-support/postgres.ts's testDatabaseUrls()) truncates and
// reseeds one shared real database in each spec's beforeEach
// (test-support/postgres.ts truncateAll), which is only safe with one spec
// file running at a time. Vitest's default file-parallelism runs spec
// files concurrently, so once those env vars are set and that tier actually
// executes, file-parallelism must be disabled or concurrently-running
// specs' truncateAll calls race and wipe each other's fixtures. The default
// `pnpm test` (env vars unset, this tier skipped) is unaffected and keeps
// running spec files in parallel.
const usesRealDatabase = Boolean(
  process.env.TEST_TS_DATABASE_URL && process.env.TEST_TS_WORKER_DATABASE_URL && process.env.TEST_TS_ADMIN_DATABASE_URL,
);

// TI-04: CI (REQUIRE_DB_TESTS=1) also writes a JSON report so a
// "check-test-floor" CI step can assert a minimum executed-test count --
// REQUIRE_DB_TESTS alone already turns a missing/typo'd env var into a
// thrown error (test-support/postgres.ts), but a floor catches a different
// regression shape: a test file re-gated by a NEW skipIf/it.skip that still
// leaves the suite green, just quietly smaller. Not written for local
// `pnpm test` runs -- only when the tier that actually runs is the one CI
// is meant to gate.
const requireDbTests = Boolean(process.env.REQUIRE_DB_TESTS);

export default defineConfig({
  // Vite's default esbuild transform doesn't emit TypeScript's
  // `emitDecoratorMetadata` output (only tsc/swc do), which NestJS's DI and
  // ValidationPipe rely on to resolve constructor/parameter types -- swc
  // does emit it, so it replaces esbuild for this project's TS files.
  plugins: [swc.vite({ tsconfigFile: "tsconfig.json" })],
  test: {
    globals: false,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    setupFiles: ["src/test-support/setup.ts"],
    reporters: requireDbTests ? ["default", "json"] : "default",
    outputFile: requireDbTests ? { json: "vitest-report.json" } : undefined,
    fileParallelism: !usesRealDatabase,
  },
});
