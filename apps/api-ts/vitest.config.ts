import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// The Postgres/RLS integration tier (*.repository.prisma.spec.ts, gated on
// TEST_DATABASE_URL/TEST_WORKER_DATABASE_URL/TEST_ADMIN_DATABASE_URL --
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
  process.env.TEST_DATABASE_URL && process.env.TEST_WORKER_DATABASE_URL && process.env.TEST_ADMIN_DATABASE_URL,
);

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
    reporters: "default",
    fileParallelism: !usesRealDatabase,
  },
});
