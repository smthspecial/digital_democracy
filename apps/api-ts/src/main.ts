// Real runtime entry point -- unlike the test process (whose reflect-metadata
// import lives in test-support/setup.ts via vitest's setupFiles), nothing
// else imports it for `pnpm start`/`pnpm dev`, so it's done here first.
import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { DomainErrorFilter } from "./common/domain-error.filter.js";
import { metricsMiddleware } from "./metrics/metrics.middleware.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.use(metricsMiddleware);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new DomainErrorFilter());
  await app.listen(process.env.PORT ?? 4000);
}

bootstrap();
