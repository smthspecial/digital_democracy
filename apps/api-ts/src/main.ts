// Real runtime entry point -- unlike the test process (whose reflect-metadata
// import lives in test-support/setup.ts via vitest's setupFiles), nothing
// else imports it for `pnpm start`/`pnpm dev`, so it's done here first.
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { createAuthContextMiddleware } from "./common/auth-context.js";
import { createRateLimitMiddleware } from "./common/rate-limit.js";
import { DomainErrorFilter } from "./common/domain-error.filter.js";
import { metricsMiddleware } from "./metrics/metrics.middleware.js";

import { validateProductionConfig } from "./common/production-config.js";

async function bootstrap() {
  validateProductionConfig();
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.enableShutdownHooks();
  app.use(createRateLimitMiddleware());
  app.use(createAuthContextMiddleware());
  app.use(metricsMiddleware);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new DomainErrorFilter());
  await app.listen(process.env.PORT ?? 4000, process.env.LISTEN_HOST ?? "0.0.0.0");
}

bootstrap();
