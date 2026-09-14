// NestJS's constructor-injection DI resolves parameter types via
// reflect-metadata (emitDecoratorMetadata); it must be imported once before
// any decorated class loads. main.ts does this for the real app -- tests
// that build a Nest testing module need the same import, done once here via
// vitest's `setupFiles` (vitest.config.ts) rather than in every spec file.
import "reflect-metadata";
